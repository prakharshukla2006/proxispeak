const mongoose = require('mongoose');

const RoomSchema = new mongoose.Schema({
  name:      { type: String, required: true, unique: true, trim: true },
  createdAt: { type: Date, default: Date.now },
  lastActive:{ type: Date, default: Date.now },
  maxUsers:  { type: Number, default: 20 }
});

module.exports = mongoose.model('Room', RoomSchema);
