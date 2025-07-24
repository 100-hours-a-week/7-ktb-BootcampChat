// backend/models/Room.js - bcrypt 에러 해결
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const RoomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  hasPassword: {
    type: Boolean,
    default: false
  },
  password: {
    type: String,
    select: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
});

// 비밀번호 해싱 미들웨어
RoomSchema.pre('save', async function(next) {
  try {
    if (this.isModified('password') && this.password) {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
      this.hasPassword = true;
    }
    if (!this.password) {
      this.hasPassword = false;
    }
    next();
  } catch (error) {
    console.error('Room password hashing error:', error);
    next(error);
  }
});

// 비밀번호 확인 메서드 수정
RoomSchema.methods.checkPassword = async function(inputPassword) {
  try {
    // 비밀번호가 설정되지 않은 방인 경우 true 반환
    if (!this.hasPassword) {
      return true;
    }

    // 입력된 비밀번호가 없는 경우 false 반환
    if (!inputPassword || inputPassword === undefined || inputPassword === null) {
      console.log('No password provided for password-protected room');
      return false;
    }

    // 문자열로 변환 (안전성 확보)
    const passwordString = String(inputPassword).trim();
    if (!passwordString) {
      console.log('Empty password provided');
      return false;
    }

    // 데이터베이스에서 비밀번호 조회
    const room = await this.constructor.findById(this._id).select('+password');
    if (!room || !room.password) {
      console.error('Room password not found in database');
      return false;
    }

    // bcrypt 비교
    const isMatch = await bcrypt.compare(passwordString, room.password);
    console.log(`Password check result for room ${this._id}:`, isMatch);
    return isMatch;

  } catch (error) {
    console.error('Password check error:', error);
    return false;
  }
};

// 비밀번호 설정 메서드 추가
RoomSchema.methods.setPassword = async function(newPassword) {
  try {
    if (!newPassword || newPassword.trim() === '') {
      this.password = undefined;
      this.hasPassword = false;
    } else {
      this.password = newPassword.trim();
      this.hasPassword = true;
    }
    return await this.save();
  } catch (error) {
    console.error('Set password error:', error);
    throw error;
  }
};

// 비밀번호 제거 메서드
RoomSchema.methods.removePassword = async function() {
  try {
    this.password = undefined;
    this.hasPassword = false;
    return await this.save();
  } catch (error) {
    console.error('Remove password error:', error);
    throw error;
  }
};

// Room 인덱스 최적화
RoomSchema.index({ createdAt: -1 });
RoomSchema.index({ name: 1 });
RoomSchema.index({ participants: 1 });
RoomSchema.index({ creator: 1, createdAt: -1 });
RoomSchema.index({ hasPassword: 1, createdAt: -1 });
RoomSchema.index({ participants: 1, createdAt: -1 });

module.exports = mongoose.model('Room', RoomSchema);