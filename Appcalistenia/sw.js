// Service Worker para cache de vídeos - v4 BRUTE FORCE
// Estratégia: simplicidade absoluta. Em cache miss:
//   1. fetch direto, sem tee, sem dedup, sem stream surgery
//   2. Devolve a Response IMEDIATAMENTE para o player
//   3. Em background (waitUntil), clona e grava no cache se for 200 OK completo
const CACHE_NAME = 'video-cache-v3';
const OLD_CACHES = ['video-cache-v1', 'video-cache-v2'];
const MAX_ITEMS = 40;

self.addEventListener('install', () => {
  console.log('[SW] Install - v4 brute force');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activate - limpando caches antigos');
  event.waitUntil(
    Promise.all([
      ...OLD_CACHES.map((name) =>
        caches.delete(name).then((deleted) => {
          if (deleted) console.log('[SW] 🗑️ Cache antigo deletado:', name);
        })
      ),
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (!url.pathname.startsWith('/videos/') || !url.pathname.endsWith('.mp4')) {
    return;
  }

  if (url.searchParams.has('nocache') || url.searchParams.has('retry')) {
    console.log('[SW] ⏭️ Bypass (nocache/retry):', url.pathname);
    return;
  }

  event.respondWith(handleVideoRequest(event));
});

function buildVideoHeaders(extra = {}) {
  return {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...extra,
  };
}

async function handleVideoRequest(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const url = new URL(request.url);
  const rangeHeader = request.headers.get('Range');

  // 1. CACHE HIT
  const cached = await cache.match(url.pathname, { ignoreSearch: true });
  if (cached) {
    try {
      if (rangeHeader) {
        return await handleRangeRequest(cached, rangeHeader, url.pathname, cache);
      }
      const blob = await cached.blob();
      if (!blob || blob.size === 0) {
        await cache.delete(url.pathname);
        return fetchDirect(event, cache, url.pathname);
      }
      console.log('[SW] ✅ Cache hit:', url.pathname);
      return new Response(blob, {
        status: 200,
        headers: buildVideoHeaders({ 'Content-Length': blob.size.toString() }),
      });
    } catch (err) {
      console.warn('[SW] cache read err:', err);
      await cache.delete(url.pathname).catch(() => {});
      return fetchDirect(event, cache, url.pathname);
    }
  }

  // 2. CACHE MISS - fetch direto, prioridade ao player
  return fetchDirect(event, cache, url.pathname);
}

/**
 * Fetch direto sem stream surgery. Player recebe Response imediatamente.
 * Cache é gravado em background via waitUntil (não bloqueia entrega).
 */
async function fetchDirect(event, cache, pathname) {
  console.log('[SW] ⏬ Fetch direto:', pathname);

  let response;
  try {
    response = await fetch(event.request);
  } catch (error) {
    console.error('[SW] ❌ Fetch falhou:', pathname, error);
    return new Response(null, { status: 502, statusText: 'Bad Gateway' });
  }

  // Só cacheia se for 200 OK completo (sem Range parcial real)
  // 206 parcial (seek no meio do vídeo): apenas repassa, não cacheia.
  if (response.ok && response.status === 200 && response.body) {
    const clone = response.clone();
    event.waitUntil(
      (async () => {
        try {
          await cache.put(pathname, clone);
          await trimCache(cache);
          console.log('[SW] 💾 Cached em background:', pathname);
        } catch (e) {
          console.warn('[SW] cache.put falhou:', pathname, e);
        }
      })()
    );
  }

  return response;
}

async function handleRangeRequest(cachedResponse, rangeHeader, pathname, cache) {
  let blob;
  try {
    blob = await cachedResponse.blob();
  } catch (e) {
    await cache.delete(pathname).catch(() => {});
    throw e;
  }

  const totalSize = blob.size;
  if (!totalSize) {
    await cache.delete(pathname).catch(() => {});
    throw new Error('Cached blob vazio');
  }

  const rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!rangeMatch) {
    return new Response(blob, {
      status: 200,
      headers: buildVideoHeaders({ 'Content-Length': totalSize.toString() }),
    });
  }

  let start;
  let end;
  if (rangeMatch[1] === '' && rangeMatch[2] !== '') {
    const suffixLen = parseInt(rangeMatch[2], 10);
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = parseInt(rangeMatch[1], 10);
    end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : totalSize - 1;
  }

  if (
    isNaN(start) || start < 0 || start >= totalSize ||
    end >= totalSize || start > end
  ) {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const slicedBlob = blob.slice(start, end + 1);
  const chunkSize = end - start + 1;

  return new Response(slicedBlob, {
    status: 206,
    headers: buildVideoHeaders({
      'Content-Length': chunkSize.toString(),
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
    }),
  });
}

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_ITEMS) {
    const toDelete = keys.length - MAX_ITEMS;
    for (let i = 0; i < toDelete; i++) {
      await cache.delete(keys[i]);
    }
  }
}
