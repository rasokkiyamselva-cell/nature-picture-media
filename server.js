// ============================================================
//  Nature Picture Media — Backend API (Node.js + Express)
//  COM682 CW2 — Images only — Azure App Service ready
// ============================================================

const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const { v4: uuidv4 } = require('uuid');
const { BlobServiceClient } = require('@azure/storage-blob');
const { CosmosClient }      = require('@azure/cosmos');
const appInsights           = require('applicationinsights');

const app = express();

// ── AZURE CONFIG (set in App Service → Configuration → Application Settings) ──
const STORAGE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
const BLOB_CONTAINER     = process.env.BLOB_CONTAINER_NAME             || 'nature-images';
const COSMOS_ENDPOINT    = process.env.COSMOS_DB_ENDPOINT              || '';
const COSMOS_KEY         = process.env.COSMOS_DB_KEY                   || '';
const COSMOS_DATABASE    = process.env.COSMOS_DB_NAME                  || 'NatureMediaDB';
const COSMOS_CONTAINER   = process.env.COSMOS_CONTAINER_NAME           || 'images';
const INSIGHTS_KEY       = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || '';
const PORT               = process.env.PORT || 3000;

// ── APP INSIGHTS — Advanced Feature ──
if (INSIGHTS_KEY) {
  appInsights.setup(INSIGHTS_KEY).setAutoCollectRequests(true).start();
  console.log('[AppInsights] Telemetry active');
}

// ── AZURE CLIENTS ──
let blobServiceClient, cosmosContainer;

function initAzure() {
  if (STORAGE_CONNECTION) {
    blobServiceClient = BlobServiceClient.fromConnectionString(STORAGE_CONNECTION);
    console.log('[Azure] Blob Storage connected');
  } else {
    console.warn('[Azure] No Blob Storage connection — using demo mode');
  }
  if (COSMOS_ENDPOINT && COSMOS_KEY) {
    const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
    cosmosContainer = client.database(COSMOS_DATABASE).container(COSMOS_CONTAINER);
    console.log('[Azure] Cosmos DB connected');
  } else {
    console.warn('[Azure] No Cosmos DB credentials — using in-memory store');
  }
}

// In-memory fallback for local dev / demo
let memoryStore = [];

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serves index.html from /public folder

// Image-only file filter
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (JPG, PNG, WEBP, GIF)'));
    }
  }
});

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
//  ROUTES — full CRUD for images
// ============================================================

// Health check — show Azure connection status
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Nature Picture Media API',
    timestamp: new Date().toISOString(),
    azure: {
      blobStorage: !!blobServiceClient,
      cosmosDb:    !!cosmosContainer,
      appInsights: !!INSIGHTS_KEY,
    }
  });
});

// ── GET all images ──
app.get('/api/images', async (req, res) => {
  try {
    const { category, limit = 100 } = req.query;

    if (cosmosContainer) {
      let query = 'SELECT * FROM c';
      const params = [];
      if (category) {
        query += ' WHERE c.category = @category';
        params.push({ name: '@category', value: category });
      }
      query += ' ORDER BY c.uploaded_at DESC OFFSET 0 LIMIT ' + parseInt(limit);
      const { resources } = await cosmosContainer.items
        .query({ query, parameters: params }).fetchAll();
      return res.json({ items: resources, total: resources.length });
    }

    // Fallback: in-memory
    let results = [...memoryStore]
      .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    if (category) results = results.filter(m => m.category === category);
    res.json({ items: results.slice(0, parseInt(limit)), total: results.length });

  } catch (err) {
    console.error('[GET /api/images]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET single image ──
app.get('/api/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (cosmosContainer) {
      const { resource } = await cosmosContainer.item(id, id).read();
      if (!resource) return res.status(404).json({ error: 'Image not found' });
      return res.json(resource);
    }
    const item = memoryStore.find(m => m.id === id);
    if (!item) return res.status(404).json({ error: 'Image not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST — upload new image ──
app.post('/api/images', upload.single('file'), async (req, res) => {
  try {
    const { title, category = 'other', tags = '[]' } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });

    const id         = uuidv4();
    const parsedTags = typeof tags === 'string' ? JSON.parse(tags) : tags;
    const ext        = req.file.originalname.split('.').pop().toLowerCase();
    const fileName   = `${id}.${ext}`;
    let   blobUrl    = null;

    // Upload to Azure Blob Storage
    if (blobServiceClient) {
      const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER);
      await containerClient.createIfNotExists({ access: 'blob' });
      const blobClient = containerClient.getBlockBlobClient(fileName);
      await blobClient.uploadData(req.file.buffer, {
        blobHTTPHeaders: { blobContentType: req.file.mimetype }
      });
      blobUrl = blobClient.url;
      console.log(`[Blob] Uploaded: ${fileName} (${req.file.size} bytes)`);
    }

    const doc = {
      id,
      title,
      category,
      tags:        parsedTags,
      media_type:  'image',
      file_name:   fileName,
      blob_url:    blobUrl,
      size_bytes:  req.file.size,
      mime_type:   req.file.mimetype,
      uploaded_at: new Date().toISOString(),
    };

    // Save metadata to Cosmos DB
    if (cosmosContainer) {
      await cosmosContainer.items.create(doc);
      console.log(`[Cosmos] Created: ${id}`);
    } else {
      memoryStore.unshift(doc);
    }

    res.status(201).json(doc);

  } catch (err) {
    console.error('[POST /api/images]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT — update image metadata ──
app.put('/api/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, tags } = req.body;

    if (cosmosContainer) {
      const { resource: existing } = await cosmosContainer.item(id, id).read();
      if (!existing) return res.status(404).json({ error: 'Image not found' });
      const updated = {
        ...existing,
        ...(title    !== undefined && { title }),
        ...(category !== undefined && { category }),
        ...(tags     !== undefined && { tags }),
        updated_at: new Date().toISOString(),
      };
      const { resource } = await cosmosContainer.item(id, id).replace(updated);
      return res.json(resource);
    }

    const idx = memoryStore.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Image not found' });
    memoryStore[idx] = {
      ...memoryStore[idx],
      ...(title    !== undefined && { title }),
      ...(category !== undefined && { category }),
      ...(tags     !== undefined && { tags }),
      updated_at: new Date().toISOString(),
    };
    res.json(memoryStore[idx]);

  } catch (err) {
    console.error('[PUT /api/images]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE — remove image from Blob + Cosmos ──
app.delete('/api/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let doc;

    if (cosmosContainer) {
      const { resource } = await cosmosContainer.item(id, id).read();
      if (!resource) return res.status(404).json({ error: 'Image not found' });
      doc = resource;
      await cosmosContainer.item(id, id).delete();
      console.log(`[Cosmos] Deleted document: ${id}`);
    } else {
      const idx = memoryStore.findIndex(m => m.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Image not found' });
      doc = memoryStore[idx];
      memoryStore.splice(idx, 1);
    }

    // Delete blob file
    if (doc.file_name && blobServiceClient) {
      const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER);
      await containerClient.getBlockBlobClient(doc.file_name).deleteIfExists();
      console.log(`[Blob] Deleted file: ${doc.file_name}`);
    }

    res.json({ deleted: true, id });

  } catch (err) {
    console.error('[DELETE /api/images]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Error handler ──
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ──
initAzure();
app.listen(PORT, () => {
  console.log('\n🌿 Nature Picture Media API');
  console.log(`   Port    : ${PORT}`);
  console.log(`   Health  : http://localhost:${PORT}/health`);
  console.log(`   GET     : /api/images`);
  console.log(`   GET     : /api/images/:id`);
  console.log(`   POST    : /api/images  (multipart, image files only)`);
  console.log(`   PUT     : /api/images/:id`);
  console.log(`   DELETE  : /api/images/:id\n`);
});

module.exports = app;
