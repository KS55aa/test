// ===== Screen Mirror WebSocket Signaling Server =====
// Dieser Server koordiniert die Verbindungen zwischen Host und Viewern

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Konfiguration
const HTTP_PORT = 8080;
const WS_PORT = 8080;

// Session-Speicher
// Format: { code: { host: WebSocket, viewers: [WebSocket], offer: RTCSessionDescription } }
const sessions = new Map();

// HTTP-Server für die HTML-Datei
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Fehler beim Laden der Datei');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Nicht gefunden');
    }
});

// WebSocket-Server
const wss = new WebSocket.Server({ server });

// Hilfsfunktion: 4-stelligen Code generieren
function generateCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (sessions.has(code));
    return code;
}

// Hilfsfunktion: Nachricht senden (mit Fehlerbehandlung)
function sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// Hilfsfunktion: Session aufräumen
function cleanupSession(code) {
    const session = sessions.get(code);
    if (session) {
        // Host benachrichtigen
        if (session.host && session.host.readyState === WebSocket.OPEN) {
            sendMessage(session.host, { 
                type: 'session-ended',
                code: code 
            });
        }
        
        // Alle Viewer benachrichtigen
        session.viewers.forEach(viewer => {
            if (viewer.readyState === WebSocket.OPEN) {
                sendMessage(viewer, { 
                    type: 'session-ended',
                    code: code 
                });
            }
        });
        
        sessions.delete(code);
        console.log(`Session ${code} beendet und aufgeräumt`);
    }
}

// WebSocket-Verbindungen verwalten
wss.on('connection', (ws) => {
    console.log('Neuer Client verbunden');
    
    // Client-Metadaten
    ws.sessionCode = null;
    ws.role = null; // 'host' oder 'viewer'
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (error) {
            console.error('Fehler beim Parsen der Nachricht:', error);
            sendMessage(ws, { 
                type: 'error', 
                message: 'Ungültige Nachricht' 
            });
        }
    });
    
    ws.on('close', () => {
        console.log('Client getrennt');
        handleDisconnect(ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket Fehler:', error);
    });
});

// Nachrichten verarbeiten
function handleMessage(ws, message) {
    console.log(`Nachricht empfangen: ${message.type}`);
    
    switch (message.type) {
        case 'create-session':
            handleCreateSession(ws);
            break;
            
        case 'join-session':
            handleJoinSession(ws, message.code);
            break;
            
        case 'offer':
            handleOffer(ws, message);
            break;
            
        case 'answer':
            handleAnswer(ws, message);
            break;
            
        case 'ice-candidate':
            handleIceCandidate(ws, message);
            break;
            
        case 'end-session':
            handleEndSession(ws, message.code);
            break;
            
        case 'leave-session':
            handleLeaveSession(ws, message.code);
            break;
            
        default:
            console.log(`Unbekannter Nachrichtentyp: ${message.type}`);
    }
}

// Session erstellen (Host)
function handleCreateSession(ws) {
    const code = generateCode();
    
    sessions.set(code, {
        host: ws,
        viewers: [],
        createdAt: Date.now()
    });
    
    ws.sessionCode = code;
    ws.role = 'host';
    
    sendMessage(ws, {
        type: 'session-created',
        code: code
    });
    
    console.log(`Session ${code} erstellt`);
}

// Session beitreten (Viewer)
function handleJoinSession(ws, code) {
    const session = sessions.get(code);
    
    if (!session) {
        sendMessage(ws, {
            type: 'session-not-found',
            code: code
        });
        return;
    }
    
    // Viewer zur Session hinzufügen
    session.viewers.push(ws);
    ws.sessionCode = code;
    ws.role = 'viewer';
    
    console.log(`Viewer der Session ${code} beigetreten (${session.viewers.length} Viewer)`);
    
    // Host benachrichtigen
    sendMessage(session.host, {
        type: 'viewer-joined',
        viewerCount: session.viewers.length
    });
    
    // Host muss jetzt eine Peer-Connection für diesen Viewer erstellen
    // Wir bitten den Host, ein Offer zu erstellen
    sendMessage(session.host, {
        type: 'create-offer-for-viewer',
        viewerId: session.viewers.length - 1
    });
}

// Offer verarbeiten (von Host zu Viewer)
function handleOffer(ws, message) {
    const session = sessions.get(message.code);
    
    if (!session || ws.role !== 'host') {
        console.error('Ungültige Offer-Nachricht');
        return;
    }
    
    // Offer an alle Viewer weiterleiten
    session.viewers.forEach((viewer, index) => {
        sendMessage(viewer, {
            type: 'offer',
            offer: message.offer,
            from: 'host'
        });
    });
    
    console.log(`Offer für Session ${message.code} weitergeleitet`);
}

// Answer verarbeiten (von Viewer zu Host)
function handleAnswer(ws, message) {
    const session = sessions.get(message.code);
    
    if (!session || ws.role !== 'viewer') {
        console.error('Ungültige Answer-Nachricht');
        return;
    }
    
    // Answer an Host weiterleiten
    sendMessage(session.host, {
        type: 'answer',
        answer: message.answer,
        from: ws
    });
    
    console.log(`Answer für Session ${message.code} weitergeleitet`);
}

// ICE-Kandidaten verarbeiten
function handleIceCandidate(ws, message) {
    const session = sessions.get(message.code);
    
    if (!session) {
        console.error('Session nicht gefunden für ICE-Kandidat');
        return;
    }
    
    if (ws.role === 'host') {
        // ICE-Kandidat vom Host an alle Viewer
        session.viewers.forEach(viewer => {
            sendMessage(viewer, {
                type: 'ice-candidate',
                candidate: message.candidate
            });
        });
    } else if (ws.role === 'viewer') {
        // ICE-Kandidat vom Viewer an Host
        sendMessage(session.host, {
            type: 'ice-candidate',
            candidate: message.candidate,
            from: ws
        });
    }
}

// Session beenden (Host)
function handleEndSession(ws, code) {
    if (ws.role === 'host') {
        cleanupSession(code);
    }
}

// Session verlassen (Viewer)
function handleLeaveSession(ws, code) {
    const session = sessions.get(code);
    
    if (!session) return;
    
    if (ws.role === 'viewer') {
        const index = session.viewers.indexOf(ws);
        if (index > -1) {
            session.viewers.splice(index, 1);
            
            // Host über Viewer-Abgang informieren
            sendMessage(session.host, {
                type: 'viewer-left',
                viewerCount: session.viewers.length
            });
            
            console.log(`Viewer hat Session ${code} verlassen (${session.viewers.length} verbleibend)`);
        }
    }
}

// Disconnect behandeln
function handleDisconnect(ws) {
    if (!ws.sessionCode) return;
    
    const session = sessions.get(ws.sessionCode);
    if (!session) return;
    
    if (ws.role === 'host') {
        // Host hat getrennt - Session beenden
        cleanupSession(ws.sessionCode);
    } else if (ws.role === 'viewer') {
        // Viewer hat getrennt - aus Liste entfernen
        handleLeaveSession(ws, ws.sessionCode);
    }
}

// Alte Sessions aufräumen (alle 5 Minuten)
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 Minuten
    
    sessions.forEach((session, code) => {
        if (now - session.createdAt > timeout) {
            console.log(`Session ${code} durch Timeout beendet`);
            cleanupSession(code);
        }
    });
}, 60000); // Jede Minute prüfen

// Server starten
server.listen(HTTP_PORT, '0.0.0.0', () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    
    console.log('\n==============================================');
    console.log('🚀 Screen Mirror Server läuft!');
    console.log('==============================================\n');
    
    console.log('Verfügbare URLs:');
    console.log(`   Lokal:     http://localhost:${HTTP_PORT}`);
    
    // Alle lokalen IP-Adressen anzeigen
    Object.keys(interfaces).forEach(name => {
        interfaces[name].forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`   Netzwerk:  http://${iface.address}:${HTTP_PORT}`);
            }
        });
    });
    
    console.log('\n💡 Öffne diese URL auf allen Geräten im selben Netzwerk!');
    console.log('==============================================\n');
});

// Graceful Shutdown
process.on('SIGTERM', () => {
    console.log('Server wird beendet...');
    sessions.forEach((session, code) => cleanupSession(code));
    wss.close(() => {
        server.close(() => {
            console.log('Server beendet');
            process.exit(0);
        });
    });
});
