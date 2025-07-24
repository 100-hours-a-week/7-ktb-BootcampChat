const mongoose = require('mongoose');
const Room = require('../models/Room');
const User = require('../models/User');
const Message = require('../models/Message');

class DBIndexService {
  constructor() {
    this.indexesCreated = false;
  }

  // 모든 인덱스 생성
  async createAllIndexes() {
    if (this.indexesCreated) {
      console.log('⚠️  인덱스가 이미 생성되었습니다.');
      return;
    }

    console.log('🔧 MongoDB 인덱스 생성 시작...');

    try {
      await Promise.all([
        this.createUserIndexes(),
        this.createRoomIndexes(),
        this.createMessageIndexes()
      ]);

      this.indexesCreated = true;
      console.log('✅ 모든 인덱스 생성 완료!');
    } catch (error) {
      console.error('❌ 인덱스 생성 실패:', error);
      throw error;
    }
  }

  // 사용자 인덱스
  async createUserIndexes() {
    console.log('👤 User 인덱스 생성 중...');
    
    try {
      // 기존 인덱스 확인 후 생성
      const existingIndexes = await User.collection.listIndexes().toArray();
      const indexNames = existingIndexes.map(idx => idx.name);
      
      const indexesToCreate = [];
      
      // 이메일 인덱스 (이미 존재하면 건너뜀)
      if (!indexNames.includes('email_unique') && !indexNames.includes('email_1')) {
        indexesToCreate.push({ key: { email: 1 }, unique: true, name: 'email_unique' });
      }
      
      // 나머지 인덱스들
      if (!indexNames.includes('name_search')) {
        indexesToCreate.push({ key: { name: 1 }, name: 'name_search' });
      }
      if (!indexNames.includes('created_desc')) {
        indexesToCreate.push({ key: { createdAt: -1 }, name: 'created_desc' });
      }
      if (!indexNames.includes('active_users')) {
        indexesToCreate.push({ key: { isActive: 1, lastLogin: -1 }, name: 'active_users' });
      }
      
      if (indexesToCreate.length > 0) {
        await User.collection.createIndexes(indexesToCreate);
        console.log(`✅ User 인덱스 ${indexesToCreate.length}개 생성 완료`);
      } else {
        console.log('✅ User 인덱스 이미 존재함');
      }
      
    } catch (error) {
      console.warn('⚠️  User 인덱스 생성 부분 실패:', error.message);
    }
  }

  // 채팅방 인덱스
  async createRoomIndexes() {
    console.log('🏠 Room 인덱스 생성 중...');
    
    await Room.collection.createIndexes([
      // 이름 검색용 (텍스트 인덱스)
      { key: { name: 'text', description: 'text' }, name: 'room_text_search' },
      
      // 생성일 정렬용 (기본 정렬)
      { key: { createdAt: -1 }, name: 'created_desc' },
      
      // 참가자 수 정렬용
      { key: { participantsCount: -1 }, name: 'participants_desc' },
      
      // 생성자별 방 조회
      { key: { creator: 1, createdAt: -1 }, name: 'creator_rooms' },
      
      // 참가자별 방 조회
      { key: { participants: 1 }, name: 'participant_rooms' },
      
      // 공개방 조회용
      { key: { hasPassword: 1, createdAt: -1 }, name: 'public_rooms' },
      
      // 복합 인덱스: 활성 방 조회
      { key: { isActive: 1, lastActivity: -1 }, name: 'active_rooms' }
    ]);

    console.log('✅ Room 인덱스 생성 완료');
  }

  // 메시지 인덱스
  async createMessageIndexes() {
    console.log('💬 Message 인덱스 생성 중...');
    
    await Message.collection.createIndexes([
      // 방별 메시지 조회 (가장 중요!)
      { key: { room: 1, createdAt: -1 }, name: 'room_messages' },
      
      // 사용자별 메시지 조회
      { key: { sender: 1, createdAt: -1 }, name: 'user_messages' },
      
      // 메시지 타입별 조회
      { key: { type: 1, createdAt: -1 }, name: 'message_type' },
      
      // AI 메시지 조회
      { key: { type: 1, aiType: 1, createdAt: -1 }, name: 'ai_messages' },
      
      // 파일 메시지 조회
      { key: { type: 1, 'file.fileType': 1, createdAt: -1 }, name: 'file_messages' },
      
      // 텍스트 검색용
      { key: { content: 'text' }, name: 'message_text_search' },
      
      // 읽음 상태 조회
      { key: { 'readBy.user': 1, room: 1 }, name: 'read_status' },
      
      // 반응 조회
      { key: { 'reactions.user': 1, room: 1 }, name: 'message_reactions' }
    ]);

    console.log('✅ Message 인덱스 생성 완료');
  }

  // 인덱스 상태 확인
  async getIndexStats() {
    try {
      const userIndexes = await User.collection.listIndexes().toArray();
      const roomIndexes = await Room.collection.listIndexes().toArray();
      const messageIndexes = await Message.collection.listIndexes().toArray();

      return {
        users: userIndexes.length,
        rooms: roomIndexes.length,
        messages: messageIndexes.length,
        total: userIndexes.length + roomIndexes.length + messageIndexes.length,
        details: {
          users: userIndexes.map(idx => idx.name),
          rooms: roomIndexes.map(idx => idx.name),
          messages: messageIndexes.map(idx => idx.name)
        }
      };
    } catch (error) {
      console.error('인덱스 상태 조회 실패:', error);
      return { error: error.message };
    }
  }

  // 쿼리 성능 분석
  async analyzeQuery(collection, query) {
    try {
      const explain = await collection.find(query).explain('executionStats');
      
      return {
        indexUsed: explain.executionStats.totalKeysExamined > 0,
        executionTime: explain.executionStats.executionTimeMillis,
        documentsExamined: explain.executionStats.totalDocsExamined,
        documentsReturned: explain.executionStats.totalDocsReturned,
        indexName: explain.executionStats.executionStages?.indexName || 'COLLSCAN',
        efficient: explain.executionStats.totalDocsExamined === explain.executionStats.totalDocsReturned
      };
    } catch (error) {
      console.error('쿼리 분석 실패:', error);
      return { error: error.message };
    }
  }

  // 인덱스 삭제 (개발용)
  async dropAllCustomIndexes() {
    console.log('🗑️  커스텀 인덱스 삭제 중...');
    
    try {
      // _id 인덱스를 제외한 모든 인덱스 삭제
      await User.collection.dropIndexes();
      await Room.collection.dropIndexes();
      await Message.collection.dropIndexes();
      
      this.indexesCreated = false;
      console.log('✅ 커스텀 인덱스 삭제 완료');
    } catch (error) {
      console.error('❌ 인덱스 삭제 실패:', error);
      throw error;
    }
  }
}

module.exports = new DBIndexService(); 