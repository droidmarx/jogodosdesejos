/**
 * Desejos – criptografia AES-GCM dos textos na API + notificações locais
 * (polling; push remoto exigiria backend)
 */
(function (global) {
  const CRYPTO_PASSPHRASE = 'Tayna&Guilherme-Desejos-Secret-2024';
  const CRYPTO_SALT = 'desejos-salt-v1';

  let cryptoKey = null;
  let lastSnapshot = null;
  let notifAsked = false;

  async function getCryptoKey() {
    if (cryptoKey) return cryptoKey;
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(CRYPTO_PASSPHRASE),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    cryptoKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc.encode(CRYPTO_SALT),
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return cryptoKey;
  }

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64ToBuf(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }

  async function encryptText(plain) {
    if (!plain || typeof plain !== 'string') return plain;
    if (plain.startsWith('enc:v1:')) return plain;
    try {
      const key = await getCryptoKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(plain)
      );
      return 'enc:v1:' + bufToB64(iv) + ':' + bufToB64(cipher);
    } catch (e) {
      console.error('encrypt failed', e);
      return plain;
    }
  }

  async function decryptText(data) {
    if (!data || typeof data !== 'string') return data;
    if (!data.startsWith('enc:v1:')) return data;
    try {
      const parts = data.split(':');
      if (parts.length < 4) return data;
      const iv = b64ToBuf(parts[2]);
      const cipher = b64ToBuf(parts.slice(3).join(':'));
      const key = await getCryptoKey();
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        key,
        cipher
      );
      return new TextDecoder().decode(plain);
    } catch (e) {
      console.error('decrypt failed', e);
      return '[não foi possível descriptografar]';
    }
  }

  async function decryptGame(g) {
    if (!g || !Array.isArray(g.desires)) return g;
    for (const d of g.desires) {
      if (d && d.text) d.text = await decryptText(d.text);
    }
    return g;
  }

  async function encryptGame(g) {
    const clone = JSON.parse(JSON.stringify(g));
    if (Array.isArray(clone.desires)) {
      for (const d of clone.desires) {
        if (d && d.text) d.text = await encryptText(d.text);
      }
    }
    return clone;
  }

  async function ensureNotificationPermission() {
    if (!('Notification' in global)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    if (notifAsked) return false;
    notifAsked = true;
    try {
      return (await Notification.requestPermission()) === 'granted';
    } catch (e) {
      return false;
    }
  }

  function showLocalNotification(title, body, tag) {
    if (!('Notification' in global) || Notification.permission !== 'granted') return;
    const opts = {
      body: body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: tag || 'desejos',
      renotify: true,
      vibrate: [40, 30, 40]
    };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {
          new Notification(title, opts);
        });
      } else {
        new Notification(title, opts);
      }
    } catch (e) {
      console.warn('notif', e);
    }
  }

  function snapshot(g) {
    if (!g) return '';
    try {
      return JSON.stringify({
        scores: g.players,
        active: g.active,
        reset: g.resetRequest,
        desires: (g.desires || []).map((d) => ({
          id: d.id,
          status: d.status,
          writer: d.writer,
          confirmRequestedBy: d.confirmRequestedBy
        }))
      });
    } catch (e) {
      return String(Date.now());
    }
  }

  function detectChanges(prevSnap, g, currentUser, ctx) {
    if (!prevSnap || !g || !currentUser) return;
    const other = ctx.otherUser(currentUser);
    const otherName = (ctx.CREDENTIALS[other] && ctx.CREDENTIALS[other].name) || other;
    let prev;
    try {
      prev = JSON.parse(prevSnap);
    } catch (e) {
      return;
    }

    const pendingMine = (g.desires || []).filter(
      (d) => d.writer === currentUser && d.status === 'pending_confirm'
    );
    const prevPendingIds = (prev.desires || [])
      .filter((d) => d.writer === currentUser && d.status === 'pending_confirm')
      .map((d) => d.id);
    pendingMine.forEach((d) => {
      if (!prevPendingIds.includes(d.id)) {
        showLocalNotification(
          'Confirmação pedida 💌',
          otherName + ' diz que cumpriu um desejo seu. Abra o app para confirmar.',
          'pending-' + d.id
        );
      }
    });

    const prevActive = prev.active && prev.active[currentUser];
    const nowActive = g.active && g.active[currentUser];
    if (!prevActive && nowActive) {
      showLocalNotification(
        'Novo desejo revelado 🎲',
        'Você tem um desejo ativo para cumprir!',
        'reveal-' + nowActive
      );
    }

    if (!prev.reset && g.resetRequest && g.resetRequest.from !== currentUser) {
      const fromName =
        (ctx.CREDENTIALS[g.resetRequest.from] && ctx.CREDENTIALS[g.resetRequest.from].name) ||
        g.resetRequest.from;
      showLocalNotification(
        'Solicitação de reset 🔄',
        fromName + ' pediu para resetar o jogo.',
        'reset'
      );
    }

    const prevMyReq = (prev.desires || [])
      .filter((d) => d.confirmRequestedBy === currentUser && d.status === 'pending_confirm')
      .map((d) => d.id);
    (g.desires || []).forEach((d) => {
      if (prevMyReq.includes(d.id) && d.status === 'completed') {
        showLocalNotification(
          'Desejo confirmado! 🎉',
          '+' + ctx.POINTS_SUCCESS + ' pontos',
          'ok-' + d.id
        );
      }
      if (prevMyReq.includes(d.id) && d.status === 'active') {
        showLocalNotification(
          'Confirmação recusada',
          'O desejo continua ativo. Continue tentando!',
          'rej-' + d.id
        );
      }
    });
  }

  function init() {
    getCryptoKey().catch(function () {});
    ensureNotificationPermission();
  }

  function onGameLoaded(game, currentUser, ctx) {
    detectChanges(lastSnapshot, game, currentUser, ctx);
    lastSnapshot = snapshot(game);
  }

  global.DesejosCrypto = {
    init: init,
    decryptGame: decryptGame,
    encryptGame: encryptGame,
    onGameLoaded: onGameLoaded,
    encryptText: encryptText,
    decryptText: decryptText
  };
})(typeof window !== 'undefined' ? window : self);
