import * as PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    try {
      const parser = new PostalMime.default();
      const rawEmail = new Response(message.raw);
      const emailData = await parser.parse(await rawEmail.arrayBuffer());

      // Extraer información relevante
      const emailRecord = {
        from: message.from,
        to: message.to,
        subject: emailData.subject || '(Sin asunto)',
        text: emailData.text || '',
        html: emailData.html || '',
        headers: JSON.stringify([...message.headers]),
        date: emailData.date || new Date().toISOString(),
        raw_size: message.rawSize,
        message_id: emailData.messageId || null,
        received_at: new Date().toISOString()
      };

      const formatMX = (value) => {
        const d = new Date(value);
        const fmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Mexico_City',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
        const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
      };

      const receivedAtMX = formatMX(emailRecord.received_at);
      const emailDateMX = formatMX(emailRecord.date);

      const insertStmt = env.DB.prepare(`
        INSERT INTO emails (
          from_address,
          to_address,
          subject,
          text_content,
          html_content,
          headers,
          email_date,
          raw_size,
          message_id,
          received_at,
          received_at_mx,
          email_date_mx
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        emailRecord.from,
        emailRecord.to,
        emailRecord.subject,
        emailRecord.text,
        emailRecord.html,
        emailRecord.headers,
        emailRecord.date,
        emailRecord.raw_size,
        emailRecord.message_id,
        emailRecord.received_at,
        receivedAtMX,
        emailDateMX
      );

      let result;
      try {
        result = await insertStmt.run();
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('no such table: emails')) {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS emails (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              from_address TEXT NOT NULL,
              to_address TEXT NOT NULL,
              subject TEXT,
              text_content TEXT,
              html_content TEXT,
              headers TEXT,
              email_date TEXT,
              raw_size INTEGER,
              message_id TEXT,
              received_at TEXT NOT NULL,
              received_at_mx TEXT,
              email_date_mx TEXT
            )
          `).run();
          await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at DESC)`).run();
          result = await insertStmt.run();
        } else if (msg.includes('no column named received_at_mx') || msg.includes('no column named email_date_mx') || msg.includes('has')) {
          try {
            await env.DB.prepare(`ALTER TABLE emails ADD COLUMN received_at_mx TEXT`).run();
          } catch {}
          try {
            await env.DB.prepare(`ALTER TABLE emails ADD COLUMN email_date_mx TEXT`).run();
          } catch {}
          result = await insertStmt.run();
        } else {
          throw e;
        }
      }

      console.log(`✅ Email guardado con ID: ${result.meta.last_row_id}`);

      // Opcional: Reenviar a una dirección de backup
      // await message.forward("backup@tudominio.com");

    } catch (error) {
      console.error('❌ Error procesando email:', error);

      // En desarrollo, puedes lanzar el error para debugging
      if (env.ENVIRONMENT === 'development') {
        throw error;
      }

      // En producción, puedes reenviar el email para no perderlo
      // await message.forward("fallback@tudominio.com");
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/emails') {
      const listSql = `
        SELECT
          id,
          from_address,
          to_address,
          subject,
          email_date,
          received_at,
          received_at_mx,
          raw_size
        FROM emails
        ORDER BY received_at DESC
        LIMIT 100
      `;
      try {
        const rows = await env.DB.prepare(listSql).all();
        return Response.json(rows.results);
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('no such table: emails')) {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS emails (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              from_address TEXT NOT NULL,
              to_address TEXT NOT NULL,
              subject TEXT,
              text_content TEXT,
              html_content TEXT,
              headers TEXT,
              email_date TEXT,
              raw_size INTEGER,
              message_id TEXT,
              received_at TEXT NOT NULL,
              received_at_mx TEXT,
              email_date_mx TEXT
            )
          `).run();
          return Response.json([]);
        }
        throw e;
      }
    }

    if (url.pathname.startsWith('/email/')) {
      const id = url.pathname.split('/')[2];
      try {
        const row = await env.DB.prepare(`SELECT * FROM emails WHERE id = ?`).bind(id).first();
        if (!row) return Response.json({ error: 'No encontrado' }, { status: 404 });

        const wantJson = new URLSearchParams(url.search).get('format') === 'json';
        if (wantJson) {
          let headersJson = null;
          try {
            if (row.headers) headersJson = JSON.parse(row.headers);
          } catch {}
          return Response.json({ email: row, headers: headersJson });
        }

        const safeText = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const rawHtml = row.html_content || `<pre style="white-space:pre-wrap">${safeText(row.text_content)}</pre>`;
        const iframeSrc = `/email/${id}/html`;
        const page = `
          <html>
            <head>
              <title>${safeText(row.subject || 'Email')}</title>
              <meta charset="utf-8" />
              <style>
                body { font-family: Arial, sans-serif; max-width: 980px; margin: 30px auto; padding: 0 16px; }
                header { margin-bottom: 12px; }
                .meta { color: #666; font-size: 13px; }
                iframe { width: 100%; height: 80vh; border: 1px solid #ddd; border-radius: 6px; background: #fff; }
                a.btn { display:inline-block; margin: 8px 0; padding: 6px 10px; border:1px solid #ccc; border-radius:4px; text-decoration:none; color:#333; }
              </style>
            </head>
            <body>
              <header>
                <h1>${safeText(row.subject || '(Sin asunto)')}</h1>
                <div class="meta">De: ${safeText(row.from_address)} · Para: ${safeText(row.to_address)}</div>
                <div class="meta">Recibido: ${safeText(row.received_at_mx || row.received_at)}</div>
                <a class="btn" href="/email/${id}?format=json">Ver JSON</a>
              </header>
              <iframe sandbox="allow-same-origin" src="${iframeSrc}"></iframe>
            </body>
          </html>
        `;
        return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('no such table: emails')) {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS emails (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              from_address TEXT NOT NULL,
              to_address TEXT NOT NULL,
              subject TEXT,
              text_content TEXT,
              html_content TEXT,
              headers TEXT,
              email_date TEXT,
              raw_size INTEGER,
              message_id TEXT,
              received_at TEXT NOT NULL,
              received_at_mx TEXT,
              email_date_mx TEXT
            )
          `).run();
          return Response.json({ error: 'Tabla inicializada' }, { status: 201 });
        }
        throw e;
      }
    }

    if (url.pathname.startsWith('/email/') && url.pathname.endsWith('/html')) {
      const parts = url.pathname.split('/');
      const id = parts[2];
      try {
        const row = await env.DB.prepare(`SELECT html_content, text_content FROM emails WHERE id = ?`).bind(id).first();
        if (!row) return new Response('No encontrado', { status: 404, headers: { 'Content-Type': 'text/plain' } });
        const safeText = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const html = row.html_content || `<pre style="white-space:pre-wrap">${safeText(row.text_content)}</pre>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('no such table: emails')) {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS emails (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              from_address TEXT NOT NULL,
              to_address TEXT NOT NULL,
              subject TEXT,
              text_content TEXT,
              html_content TEXT,
              headers TEXT,
              email_date TEXT,
              raw_size INTEGER,
              message_id TEXT,
              received_at TEXT NOT NULL,
              received_at_mx TEXT,
              email_date_mx TEXT
            )
          `).run();
          return new Response('', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        throw e;
      }
    }

    const html = `
      <html>
        <head>
          <title>Email Worker - D1 Storage</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
            pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
          </style>
        </head>
        <body>
          <h1>📧 Email Worker - D1 Storage</h1>
          <ul>
            <li><code>GET /emails</code></li>
            <li><code>GET /email/{id}</code></li>
            <li><code>GET /email/{id}/html</code></li>
          </ul>
        </body>
      </html>
    `;
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  }
}
