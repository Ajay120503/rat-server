require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

async function setupAdmin() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

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

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({
      $or: [
        { email: 'ajaykandhare12@gmail.com' },
        { username: 'Ajay Kandhare' }
      ]
    });

    if (existingAdmin) {
      console.log('Admin already exists, updating role to admin...');
      existingAdmin.role = 'admin';
      existingAdmin.password = await bcrypt.hash('ajay@#1205', 12);
      await existingAdmin.save();
      console.log('✅ Admin updated successfully!');
      console.log('Email: ajaykandhare12@gmail.com');
      console.log('Password: ajay@#1205');
      console.log('Role: admin');
    } else {
      // Create new admin
      const hashedPassword = await bcrypt.hash('ajay@#1205', 12);
      const admin = new Admin({
        username: 'ajaykandhare12@gmail.com',
        email: 'ajaykandhare12@gmail.com',
        password: hashedPassword,
        role: 'admin',
        apiKey: uuidv4()
      });
      await admin.save();
      console.log('✅ Admin created successfully!');
      console.log('Email: ajaykandhare12@gmail.com');
      console.log('Password: ajay@#1205');
      console.log('Role: admin');
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

setupAdmin();