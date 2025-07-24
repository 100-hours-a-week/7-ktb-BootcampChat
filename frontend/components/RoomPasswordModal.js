import React, { useState, useEffect } from 'react';
import { LockIcon } from '@vapor-ui/icons';
import { Button, TextInput, Text } from '@vapor-ui/core';
import { Modal, ModalBody, ModalFooter } from './ui/Modal';
import { HStack, Stack } from './ui/Layout';

const RoomPasswordModal = ({ 
  isOpen, 
  onClose, 
  onSubmit, 
  roomName = '채팅방',
  loading = false,
  error = '',
  retryCount = 0
}) => {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // 모달이 열릴 때마다 비밀번호 초기화
  useEffect(() => {
    if (isOpen) {
      setPassword('');
    }
  }, [isOpen]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (password.trim()) {
      onSubmit(password.trim());
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !loading && password.trim()) {
      handleSubmit(e);
    }
  };

  return (
    <Modal 
      isOpen={isOpen} 
      onClose={onClose} 
      title="비밀번호 입력"
      size="sm"
    >
      <form onSubmit={handleSubmit} style={{ padding: '24px' }}>
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            <LockIcon size={20} color="#007bff" />
            <h4 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>
              {roomName}
            </h4>
          </div>
          <p style={{ margin: 0, fontSize: '14px', color: '#666', lineHeight: '1.5' }}>
            이 채팅방은 비밀번호가 설정되어 있습니다.
            {retryCount > 0 && ' 비밀번호를 다시 확인해주세요.'}
          </p>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label 
            htmlFor="roomPassword" 
            style={{ 
              display: 'block', 
              marginBottom: '8px', 
              fontSize: '14px', 
              fontWeight: '500' 
            }}
          >
            비밀번호
          </label>
          <div style={{ position: 'relative' }}>
            <input
              id="roomPassword"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={loading}
              autoFocus
              placeholder="채팅방 비밀번호를 입력하세요"
              style={{
                width: '100%',
                padding: '12px',
                paddingRight: '60px',
                border: '2px solid #ddd',
                borderRadius: '6px',
                fontSize: '16px', // 더 큰 폰트
                outline: 'none',
                boxSizing: 'border-box',
                color: '#333', // 입력 텍스트 색상
                backgroundColor: '#fff',
                transition: 'border-color 0.2s ease',
                // focus 상태
                ':focus': {
                  borderColor: '#007bff'
                }
              }}
              onFocus={(e) => {
                e.target.style.borderColor = '#007bff';
              }}
              onBlur={(e) => {
                e.target.style.borderColor = '#ddd';
              }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              style={{
                position: 'absolute',
                right: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 8px',
                fontSize: '12px',
                color: '#007bff',
                fontWeight: '500'
              }}
            >
              {showPassword ? '숨김' : '보기'}
            </button>
          </div>
        </div>

        {error && (
          <div 
            style={{
              padding: '12px',
              backgroundColor: '#fee',
              border: '1px solid #fcc',
              borderRadius: '6px',
              color: '#c33',
              fontSize: '14px',
              marginBottom: '20px'
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            style={{
              padding: '10px 20px',
              border: '1px solid #ddd',
              borderRadius: '6px',
              backgroundColor: 'white',
              color: '#333',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              fontWeight: '500'
            }}
          >
            취소
          </button>
          <button
            type="submit"
            disabled={loading || !password.trim()}
            style={{
              padding: '10px 20px',
              border: 'none',
              borderRadius: '6px',
              backgroundColor: loading || !password.trim() ? '#ccc' : '#007bff',
              color: 'white',
              cursor: loading || !password.trim() ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              fontWeight: '500'
            }}
          >
            {loading ? '확인 중...' : '입장'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default RoomPasswordModal; 