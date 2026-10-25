import { Heart, Ear, Brain, MessageCircle } from 'lucide-react';
import './character-state.css';

export type Emotion = 'neutral' | 'happy' | 'shy' | 'sad' | 'angry' | 'cold' | 'worried';
export type Gesture = 'idle' | 'listening' | 'thinking' | 'speaking';

interface CharacterStateProps {
  emotion: Emotion;
  gesture: Gesture;
  displayName: string;
  trust: number;
  affection: number;
}

const emotionConfig = {
  neutral: { color: '#94a3b8', icon: '😐', label: '平静' },
  happy: { color: '#fbbf24', icon: '😊', label: '开心' },
  shy: { color: '#f472b6', icon: '😳', label: '害羞' },
  sad: { color: '#60a5fa', icon: '😢', label: '委屈' },
  angry: { color: '#f87171', icon: '😠', label: '生气' },
  cold: { color: '#6b7280', icon: '😶', label: '冷淡' },
  worried: { color: '#a78bfa', icon: '😟', label: '担心' }
};

const gestureConfig = {
  idle: { icon: Heart, label: '待机' },
  listening: { icon: Ear, label: '倾听中' },
  thinking: { icon: Brain, label: '思考中' },
  speaking: { icon: MessageCircle, label: '回复中' }
};

export function CharacterState({ emotion, gesture, displayName, trust, affection }: CharacterStateProps) {
  const emotionData = emotionConfig[emotion];
  const gestureData = gestureConfig[gesture];
  const GestureIcon = gestureData.icon;

  return (
    <div className="character-state">
      <div className="character-avatar" style={{ borderColor: emotionData.color }}>
        <span className="character-emoji">{emotionData.icon}</span>
        <div className="gesture-indicator" style={{ backgroundColor: emotionData.color }}>
          <GestureIcon size={12} />
        </div>
      </div>
      <div className="character-info">
        <div className="character-name">{displayName}</div>
        <div className="character-status">
          <span className="emotion-label" style={{ color: emotionData.color }}>
            {emotionData.label}
          </span>
          <span className="gesture-label">{gestureData.label}</span>
        </div>
        <div className="character-stats">
          <span>信任 {trust}</span>
          <span>·</span>
          <span>亲密 {affection}</span>
        </div>
      </div>
    </div>
  );
}
