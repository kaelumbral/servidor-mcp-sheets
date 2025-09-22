import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

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

// ---------- Helpers de KV ----------
async function kvPutPrompt(env, prompt) {
  const id = prompt.id ?? (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  // Lista keys "prompt:*" y trae cada doc (simple y suficiente para volúmenes chicos/medianos)
  const keys = await env.PROMPTS_DB.list({ prefix: 'prompt:' });
  const out = [];
  for (const k of keys.keys) {
    const raw = await env.PROMPTS_DB.get(k.name);
    if (raw) out.push(JSON.parse(raw));
  }
  // Orden opcional por nombre
  out.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  return out;
}

// ---------- MCP server ----------
function buildServer(env) {
  const server = new McpServer({ name: 'mcp-gsheet', version: '1.0.0' });

  // Ping
  server.registerTool('ping',
    { title: 'Ping', description: 'Health', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'pong' }] })
  );

  // Listar prompts (desde KV)
  server.registerTool('list_prompts',
    { title: 'Listar prompts', description: 'Lee todas las filas (KV)', inputSchema: {} },
    async () => {
      const items = await kvListPrompts(env);
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    }
  );

  // Buscar por texto
  server.registerTool('find_prompts',
    { title: 'Buscar', description: 'Filtra por texto en nombre/plantilla/tags (KV)', inputSchema: { q: { type: 'string' } } },
    async ({ q }) => {
      const Q = (q || '').toLowerCase();
      const items = await kvListPrompts(env);
      const filtered = items.filter(it =>
        (it.nombre || '').toLowerCase().includes(Q) ||
        (it.plantilla || '').toLowerCase().includes(Q) ||
        (it.tags || '').toLowerCase().includes(Q)
      ).map(({ id, nombre, objetivo, tags }) => ({ id, nombre, objetivo, tags }));
      return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] };
    }
  );

  // Agregar / actualizar prompt
  server.registerTool('append_prompt',
    {
      title: 'Agregar', description: 'Inserta una fila (KV)',
      inputSchema: {
        nombre: { type: 'string' },
        objetivo: { type: 'string', optional: true },
        plantilla: { type: 'string' },
        tags: { type: 'string', optional: true },
        autor: { type: 'string', optional: true },
        notas: { type: 'string', optional: true }
      }
    },
    async (input) => {
      if (!input.nombre || !input.plantilla) {
        return { content: [{ type: 'text', text: `Error: nombre y plantilla requeridos` }] };
      }
      const id = await kvPutPrompt(env, input);
      return { content: [{ type: 'text', text: `OK - id ${id}` }] };
    }
  );

  // Marcar uso (por id o nombre)
  server.registerTool('update_last_used',
    {
      title: 'Marcar uso', description: 'Actualiza fecha_ultimo_uso por id o nombre (KV)',
      inputSchema: { id: { type: 'string', optional: true }, nombre: { type: 'string', optional: true } }
    },
    async (input) => {
      let { id, nombre } = input;
      if (!id && nombre) id = await kvGetIdByName(env, nombre);
      if (!id) return { content: [{ type: 'text', text: `Error: falta id o nombre` }] };

      const doc = await kvGetPromptById(env, id);
      if (!doc) return { content: [{ type: 'text', text: `Error: not found` }] };

      const today = new Date().toISOString().slice(0,10);
      doc.fecha_ultimo_uso = today;
      await env.PROMPTS_DB.put(`prompt:${id}`, JSON.stringify(doc));
      return { content: [{ type: 'text', text: 'OK' }] };
    }
  );

  // (Opcional) Importar desde Google Sheet a KV, usando tu Apps Script actual
  server.registerTool('import_from_sheet',
    { title: 'Importar desde Sheet', description: 'Carga items desde tu WebApp de Apps Script a KV (run once)', inputSchema: {} },
    async () => {
      if (!env.APPS_SCRIPT_URL || !env.SHARED_SECRET) {
        return { content: [{ type: 'text', text: `Error: faltan APPS_SCRIPT_URL / SHARED_SECRET en variables del Worker` }] };
      }
      const r = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', secret: env.SHARED_SECRET })
      });
      const j = await r.json().catch(() => ({}));
      const items = Array.isArray(j.items) ? j.items : [];
      let count = 0;
      for (const it of items) {
        const id = await kvPutPrompt(env, it);
        count++;
      }
      return { content: [{ type: 'text', text: `Importados ${count} items desde Sheet a KV` }] };
    }
  );

  return server;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS + health + HEAD
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
    if (request.method === 'HEAD')    return withCors(new Response(null, { status: 200 }));
    const isSSE = request.headers.get('accept')?.includes('text/event-stream');
    if (request.method === 'GET' && url.pathname === '/' && !isSSE) {
      return withCors(new Response('OK: MCP server up', { status: 200 }));
    }

    // MCP handshake/stream
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
