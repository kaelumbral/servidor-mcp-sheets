import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/* ------------ CORS ------------ */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}
function withCors(resp) {
  const h = new Headers(resp.headers || {});
  Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
  return new Response(resp.body, { status: resp.status || 200, headers: h });
}

/* ------------ KV helpers ------------ */
async function kvPutPrompt(env, prompt) {
  const id = prompt.id ?? (crypto.randomUUID ? crypto.randomUUID()
                                             : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const normName = (prompt.nombre || '').trim().toLowerCase();
  const doc = {
    id,
    nombre: prompt.nombre || '',
    objetivo: prompt.objetivo || '',
    plantilla: prompt.plantilla || '',
    tags: prompt.tags || '',
    autor: prompt.autor || '',
    fecha_creacion: prompt.fecha_creacion || new Date().toISOString().slice(0,10),
    fecha_ultimo_uso: prompt.fecha_ultimo_uso || '',
    notas: prompt.notas || '',
  };
  await env.PROMPTS_DB.put(`prompt:${id}`, JSON.stringify(doc));
  if (normName) await env.PROMPTS_DB.put(`name:${normName}`, id);
  return id;
}
async function kvGetPromptById(env, id) {
  const raw = await env.PROMPTS_DB.get(`prompt:${id}`);
  return raw ? JSON.parse(raw) : null;
}
async function kvGetIdByName(env, nombre) {
  const norm = (nombre || '').trim().toLowerCase();
  if (!norm) return null;
  return await env.PROMPTS_DB.get(`name:${norm}`);
}
async function kvListPrompts(env) {
  const keys = await env.PROMPTS_DB.list({ prefix: 'prompt:' });
  const out = [];
  for (const k of keys.keys) {
    const raw = await env.PROMPTS_DB.get(k.name);
    if (raw) out.push(JSON.parse(raw));
  }
  out.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  return out;
}

/* ------------ MCP server ------------ */
function buildServer(env) {
  const server = new McpServer({ name: 'mcp-gsheet', version: '1.0.0' });

  // Ping
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Health',
      inputSchema: { type: 'object', properties: {} }
    },
    async () => ({ content: [{ type: 'text', text: 'pong' }] })
  );

  // Listar prompts (KV)
  server.registerTool(
    'list_prompts',
    {
      title: 'Listar prompts',
      description: 'Lee todas las filas (KV)',
      inputSchema: { type: 'object', properties: {} }
    },
    async () => {
      const items = await kvListPrompts(env);
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    }
  );

  // Buscar (KV)
  server.registerTool(
    'find_prompts',
    {
      title: 'Buscar',
      description: 'Filtra por texto en nombre/plantilla/tags (KV)',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q']
      }
    },
    async ({ q }) => {
      const Q = (q || '').toLowerCase();
      const items = await kvListPrompts(env);
      const filtered = items
        .filter(it =>
          (it.nombre || '').toLowerCase().includes(Q) ||
          (it.plantilla || '').toLowerCase().includes(Q) ||
          (it.tags || '').toLowerCase().includes(Q)
        )
        .map(({ id, nombre, objetivo, tags }) => ({ id, nombre, objetivo, tags }));
      return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] };
    }
  );

  // Agregar (KV)
  server.registerTool(
    'append_prompt',
    {
      title: 'Agregar',
      description: 'Inserta o actualiza una fila (KV)',
      inputSchema: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          objetivo: { type: 'string' },
          plantilla: { type: 'string' },
          tags: { type: 'string' },
          autor: { type: 'string' },
          notas: { type: 'string' }
        },
        required: ['nombre', 'plantilla']
      }
    },
    async (input) => {
      const id = await kvPutPrompt(env, input);
      return { content: [{ type: 'text', text: `OK - id ${id}` }] };
    }
  );

  // Marcar uso (KV)
  server.registerTool(
    'update_last_used',
    {
      title: 'Marcar uso',
      description: 'Actualiza fecha_ultimo_uso por id o nombre (KV)',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          nombre: { type: 'string' }
        }
      }
    },
    async (input) => {
      let { id, nombre } = input;
      if (!id && nombre) id = await kvGetIdByName(env, nombre);
      if (!id) return { content: [{ type: 'text', text: 'Error: falta id o nombre' }] };

      const doc = await kvGetPromptById(env, id);
      if (!doc) return { content: [{ type: 'text', text: 'Error: not found' }] };

      doc.fecha_ultimo_uso = new Date().toISOString().slice(0,10);
      await env.PROMPTS_DB.put(`prompt:${id}`, JSON.stringify(doc));
      return { content: [{ type: 'text', text: 'OK' }] };
    }
  );

  // Importar desde Google Sheet (opcional)
  server.registerTool(
    'import_from_sheet',
    {
      title: 'Importar desde Sheet',
      description: 'Carga items desde tu WebApp de Apps Script a KV (run once)',
      inputSchema: { type: 'object', properties: {} }
    },
    async () => {
      if (!env.APPS_SCRIPT_URL || !env.SHARED_SECRET) {
        return { content: [{ type: 'text', text: 'Error: faltan APPS_SCRIPT_URL / SHARED_SECRET' }] };
      }
      const r = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', secret: env.SHARED_SECRET })
      });
      const j = await r.json().catch(() => ({}));
      const items = Array.isArray(j.items) ? j.items : [];
      let count = 0;
      for (const it of items) { await kvPutPrompt(env, it); count++; }
      return { content: [{ type: 'text', text: `Importados ${count} items desde Sheet a KV` }] };
    }
  );

  /* ------- Requeridos por Connectors: search & fetch ------- */

  // search → { results: [{ id, title, url }] }
  server.registerTool(
    'search',
    {
      title: 'Search',
      description: 'Busca prompts en KV (para Connectors)',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    },
    async ({ query }) => {
      const Q = (query || '').toLowerCase();
      const items = await kvListPrompts(env);
      const results = items
        .filter(it =>
          (it.nombre || '').toLowerCase().includes(Q) ||
          (it.plantilla || '').toLowerCase().includes(Q) ||
          (it.tags || '').toLowerCase().includes(Q)
        )
        .slice(0, 25)
        .map(it => ({
          id: it.id,
          title: it.nombre || '(sin nombre)',
          url: `https://servidor-mcp-sheets1.bautiarmani.workers.dev/#prompt-${it.id}`
        }));
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
    }
  );

  // fetch → { id, title, text, url, metadata }
  server.registerTool(
    'fetch',
    {
      title: 'Fetch',
      description: 'Obtiene un prompt por id (para Connectors)',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      }
    },
    async ({ id }) => {
      const doc = await kvGetPromptById(env, id);
      if (!doc) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not found', id }) }] };
      const payload = {
        id: doc.id,
        title: doc.nombre || '(sin nombre)',
        text: doc.plantilla || '',
        url: `https://servidor-mcp-sheets1.bautiarmani.workers.dev/#prompt-${doc.id}`,
        metadata: {
          objetivo: doc.objetivo || '',
          tags: doc.tags || '',
          autor: doc.autor || '',
          fecha_creacion: doc.fecha_creacion || '',
          fecha_ultimo_uso: doc.fecha_ultimo_uso || '',
          notas: doc.notas || ''
        }
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
  );

  return server;
}

/* ------------ Fetch handler ------------ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS / preflight / sondas
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
    if (request.method === 'HEAD')    return withCors(new Response(null, { status: 200 }));
    const isSSE = request.headers.get('accept')?.includes('text/event-stream');
    if (request.method === 'GET' && url.pathname === '/' && !isSSE) {
      return withCors(new Response('OK: MCP server up', { status: 200 }));
    }

    // Flujo MCP (initialize + SSE)
    try {
      const server = buildServer(env);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () =>
          (typeof crypto?.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      });
      await server.connect(transport);
      const resp = await transport.handleRequest(request);
      return withCors(resp);
    } catch (err) {
      console.error('MCP error:', err && (err.stack || err));
      return withCors(new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      }));
    }
  }
};
