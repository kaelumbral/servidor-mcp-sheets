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

function buildServer(env) {
  const server = new McpServer({ name: 'mcp-gsheet', version: '1.0.0' });

  server.registerTool('ping',
    { title: 'Ping', description: 'Health', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'pong' }] })
  );

  server.registerTool('list_prompts',
    { title: 'Listar prompts', description: 'Lee todas las filas', inputSchema: {} },
    async () => {
      const r = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', secret: env.SHARED_SECRET })
      });
      const j = await r.json();
      return { content: [{ type: 'text', text: JSON.stringify(j.items || [], null, 2) }] };
    }
  );

  server.registerTool('find_prompts',
    { title: 'Buscar', description: 'Filtra por texto en nombre/plantilla/tags', inputSchema: { q: { type: 'string' } } },
    async ({ q }) => {
      const r = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', secret: env.SHARED_SECRET })
      });
      const j = await r.json();
      const Q = (q || '').toLowerCase();
      const items = (j.items || [])
        .filter(it =>
          (it.nombre || '').toLowerCase().includes(Q) ||
          (it.plantilla || '').toLowerCase().includes(Q) ||
          (it.tags || '').toLowerCase().includes(Q)
        )
        .map(({ id, nombre, objetivo, tags }) => ({ id, nombre, objetivo, tags }));
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    }
  );

  server.registerTool('append_prompt',
    {
      title: 'Agregar', description: 'Inserta una fila',
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
      const r = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'append', secret: env.SHARED_SECRET, ...input })
      });
      const j = await r.json();
      if (!j.ok) return { content: [{ type: 'text', text: `Error: ${JSON.stringify(j)}` }] };
      return { content: [{ type: 'text', text: `OK - id ${j.id}` }] };
    }
  );

  server.registerTool('update_last_used',
    {
      title: 'Marcar uso', description: 'Actualiza fecha_ultimo_uso por id o nombre',
      inputSchema: { id: { type: 'string', optional: true }, nombre: { type: 'string', optional: true } }
    },
    async (input) => {
      const r = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_last_used', secret: env.SHARED_SECRET, ...input })
      });
      const j = await r.json();
      if (!j.ok) return { content: [{ type: 'text', text: `Error: ${JSON.stringify(j)}` }] };
      return { content: [{ type: 'text', text: 'OK' }] };
    }
  );

  return server;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Preflight y sondas
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
    if (request.method === 'HEAD' && url.pathname === '/') return withCors(new Response(null, { status: 200 }));
    // Health SOLO en "/"
    if (request.method === 'GET' && url.pathname === '/') {
      return withCors(new Response('OK: MCP server up', { status: 200 }));
    }

    // Todo lo demás → transporte MCP (incluye GET /sse del handshake)
    try {
      const server = buildServer(env);
      const transport = new StreamableHTTPServerTransport();
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
