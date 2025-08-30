import React, { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';
import type { WebSocketMessage } from '../shared/types';

const App: React.FC = () => {
  const [username, setUsername] = useState('');
  const [roomname, setRoomname] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [stage, setStage] = useState<'name' | 'room' | 'chat'>('name');
  const [messages, setMessages] = useState<Array<{ name: string | null; text: string }>>([]);
  const [roster, setRoster] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isAtBottom, setIsAtBottom] = useState(true);
  
  const wsRef = useRef<WebSocket | null>(null);
  const chatlogRef = useRef<HTMLDivElement>(null);
  const lastSeenTimestampRef = useRef(0);
  const wroteWelcomeMessagesRef = useRef(false);

  const addChatMessage = useCallback((name: string | null, text: string) => {
    setMessages(prev => [...prev, { name, text }]);
  }, []);

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.length > 0) {
      if (window.location.hash.length > 1) {
        setRoomname(window.location.hash.slice(1));
        setStage('chat');
      } else {
        setStage('room');
      }
    }
  };

  const handleRoomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomInput.length > 0) {
      setRoomname(roomInput);
      setStage('chat');
    }
  };

  const handlePrivateRoom = async () => {
    const hostname = window.location.host || 'edge-chat-demo.cloudflareworkers.com';
    const response = await fetch(`/api/room`, { method: 'POST' });
    if (response.ok) {
      const room = await response.text();
      setRoomname(room);
      setStage('chat');
    } else {
      alert('Something went wrong');
    }
  };

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ message: inputValue }));
      setInputValue('');
      if (chatlogRef.current) {
        chatlogRef.current.scrollTop = chatlogRef.current.scrollHeight;
      }
    }
  };

  const handleScroll = () => {
    if (chatlogRef.current) {
      const { scrollTop, clientHeight, scrollHeight } = chatlogRef.current;
      setIsAtBottom(scrollTop + clientHeight >= scrollHeight - 5);
    }
  };

  useEffect(() => {
    if (stage === 'chat' && roomname) {
      const normalizedRoom = roomname.replace(/[^a-zA-Z0-9_-]/g, '').replace(/_/g, '-').toLowerCase();
      window.location.hash = '#' + normalizedRoom;
      
      const hostname = window.location.host || 'edge-chat-demo.cloudflareworkers.com';
      const protocol = window.location.protocol === 'http:' ? 'ws:' : 'wss:';
      const ws = new WebSocket(`${protocol}//${hostname}/api/room/${normalizedRoom}/websocket`);
      
      ws.onopen = () => {
        ws.send(JSON.stringify({ name: username }));
      };

      ws.onmessage = (event) => {
        const data: WebSocketMessage = JSON.parse(event.data);
        
        if (data.error) {
          addChatMessage(null, `* Error: ${data.error}`);
        } else if (data.joined) {
          setRoster(prev => [...prev, data.joined!]);
        } else if (data.quit) {
          setRoster(prev => prev.filter(name => name !== data.quit));
        } else if (data.ready) {
          if (!wroteWelcomeMessagesRef.current) {
            wroteWelcomeMessagesRef.current = true;
            addChatMessage(null, '* This is a demo app built with Cloudflare Workers Durable Objects. The source code can be found at: https://github.com/cloudflare/workers-chat-demo');
            addChatMessage(null, '* WARNING: Participants in this chat are random people on the internet. Names are not authenticated; anyone can pretend to be anyone. The people you are chatting with are NOT Cloudflare employees. Chat history is saved.');
            if (normalizedRoom.length === 64) {
              addChatMessage(null, '* This is a private room. You can invite someone to the room by sending them the URL.');
            } else {
              addChatMessage(null, `* Welcome to #${normalizedRoom}. Say hi!`);
            }
          }
        } else if (data.message && data.timestamp) {
          if (data.timestamp > lastSeenTimestampRef.current) {
            addChatMessage(data.name || null, data.message);
            lastSeenTimestampRef.current = data.timestamp;
          }
        }
      };

      ws.onclose = () => {
        console.log('WebSocket closed, will attempt to reconnect');
        setRoster([]);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      wsRef.current = ws;

      return () => {
        if (wsRef.current) {
          wsRef.current.close();
        }
      };
    }
  }, [stage, roomname, username, addChatMessage]);

  useEffect(() => {
    if (chatlogRef.current && isAtBottom) {
      chatlogRef.current.scrollTop = chatlogRef.current.scrollHeight;
    }
  }, [messages, isAtBottom]);

  if (stage === 'name') {
    return (
      <form id="name-form" onSubmit={handleNameSubmit}>
        <input
          id="name-input"
          placeholder="your name"
          value={username}
          onChange={(e) => setUsername(e.target.value.slice(0, 32))}
          autoFocus
        />
        <p>
          This chat runs entirely on the edge, powered by<br />
          <a href="https://blog.cloudflare.com/introducing-workers-durable-objects" target="_blank" rel="noopener noreferrer">
            Cloudflare Workers Durable Objects
          </a>
        </p>
      </form>
    );
  }

  if (stage === 'room') {
    return (
      <form id="room-form" onSubmit={handleRoomSubmit}>
        <p>Enter a public room:</p>
        <input
          id="room-name"
          placeholder="room name"
          value={roomInput}
          onChange={(e) => setRoomInput(e.target.value.slice(0, 32))}
          autoFocus
        />
        <button type="submit" id="go-public">Go »</button>
        <p>OR</p>
        <button type="button" id="go-private" onClick={handlePrivateRoom}>
          Create a Private Room »
        </button>
      </form>
    );
  }

  return (
    <form id="chatroom" onSubmit={handleChatSubmit}>
      <div id="chatlog" ref={chatlogRef} onScroll={handleScroll}>
        <div id="spacer"></div>
        {messages.map((msg, idx) => (
          <p key={idx}>
            {msg.name && <span className="username">{msg.name}: </span>}
            {msg.text}
          </p>
        ))}
      </div>
      <div id="roster">
        {roster.map((name, idx) => (
          <p key={idx}>{name}</p>
        ))}
      </div>
      <input
        id="chat-input"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value.slice(0, 256))}
        autoFocus
      />
    </form>
  );
};

export default App;