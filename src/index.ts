/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// src/index.ts
export interface Env {
  IMAGE_BUCKET: R2Bucket;
  DB: D1Database;
  AI: Ai;
}

interface ImageMetadata {
  id: number;
  image_key: string;
  alt_text: string | null;
  content_type: string;
  created_at: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Root endpoint - Hello World
      if (path === '/' || path === '') {
        return new Response('Hello World', {
          headers: { 'Content-Type': 'text/plain', ...corsHeaders },
        });
      }

      // Debug endpoint to check bindings
      if (path === '/debug') {
        const debug = {
          bindings: {
            IMAGE_BUCKET: !!env.IMAGE_BUCKET,
            DB: !!env.DB,
            AI: !!env.AI,
          },
          timestamp: new Date().toISOString(),
        };
        return new Response(JSON.stringify(debug, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Audit endpoint
      if (path === '/audit') {
        return handleAudit(env, corsHeaders);
      }

      // Ingest endpoint
      if (path === '/ingest' && request.method === 'POST') {
        return handleIngest(request, env, ctx, corsHeaders);
      }

      // Image serving endpoint
      if (path.startsWith('/images/')) {
        const imageKey = path.substring(8); // Remove '/images/' prefix
        return handleImageRequest(imageKey, request, env, ctx, corsHeaders);
      }

      // Default 404 for unknown routes
      return new Response(
        JSON.stringify({
          message: 'Image Processor API',
          endpoints: {
            root: 'GET /',
            debug: 'GET /debug',
            audit: 'GET /audit',
            image: 'GET /images/{key}',
            ingest: 'POST /ingest',
          },
        }, null, 2),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    } catch (error) {
      console.error('Error handling request:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return new Response(
        JSON.stringify({ 
          error: 'Internal server error', 
          details: errorMessage 
        }, null, 2), 
        {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }
  },
};

// Handle image requests with caching and AI enrichment
async function handleImageRequest(
  imageKey: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Validate bindings
  if (!env.DB) {
    return new Response(
      JSON.stringify({ 
        error: 'D1 database binding not configured',
        hint: 'Check wrangler.jsonc for correct database_id' 
      }, null, 2), 
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }

  if (!env.IMAGE_BUCKET) {
    return new Response(
      JSON.stringify({ 
        error: 'R2 bucket binding not configured',
        hint: 'Check wrangler.jsonc for correct bucket_name' 
      }, null, 2), 
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }

  // Check cache first
  const cacheKey = new Request(request.url, request);
  const cache = caches.default;

  let response = await cache.match(cacheKey);
  if (response) {
    console.log(`Cache HIT for ${imageKey}`);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('X-Cache-Status', 'HIT');
    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  }

  console.log(`Cache MISS for ${imageKey}`);

  try {
    // Query D1 for metadata
    const { results } = await env.DB.prepare('SELECT * FROM images WHERE image_key = ?')
      .bind(imageKey)
      .all<ImageMetadata>();

    if (!results || results.length === 0) {
      return new Response(
        JSON.stringify({ 
          error: `Image '${imageKey}' not found in database`,
          hint: 'Run: npx wrangler d1 execute image-metadata --command="SELECT * FROM images;" --remote'
        }, null, 2), 
        {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    const metadata = results[0];

    // Fetch from R2
    const object = await env.IMAGE_BUCKET.get(imageKey);
    if (!object) {
      return new Response(
        JSON.stringify({ 
          error: `Image '${imageKey}' not found in R2 storage`,
          hint: 'Upload with: npx wrangler r2 object put image-assets/' + imageKey + ' --file=./' + imageKey
        }, null, 2), 
        {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // Check if we need to generate alt-text
    let altText = metadata.alt_text;
    const needsAiGeneration = !altText;

    // If AI generation is needed, schedule it in the background
    // We need to clone the object body for AI processing
    if (needsAiGeneration && env.AI) {
      console.log(`Scheduling alt-text generation for ${imageKey}`);
      // Read the body once and convert to ArrayBuffer for reuse
      const imageBytes = await object.arrayBuffer();
      
      // Schedule AI generation in background with the bytes
      ctx.waitUntil(generateAndStoreAltText(imageKey, imageBytes, env));
      altText = 'Generating description...';
      
      // Build response with the bytes
      response = new Response(imageBytes, {
        headers: {
          'Content-Type': metadata.content_type,
          'X-Alt-Text': altText,
          'X-Cache-Status': 'MISS',
          'X-Image-Key': imageKey,
          'Cache-Control': 'public, max-age=31536000',
          ...corsHeaders,
        },
      });
    } else {
      // No AI generation needed, use the body directly
      response = new Response(object.body, {
        headers: {
          'Content-Type': metadata.content_type,
          'X-Alt-Text': altText || 'No description available',
          'X-Cache-Status': 'MISS',
          'X-Image-Key': imageKey,
          'Cache-Control': 'public, max-age=31536000',
          ...corsHeaders,
        },
      });
    }

    // Store in cache (non-blocking)
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (error) {
    console.error(`Error processing ${imageKey}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ 
        error: 'Database query failed', 
        details: errorMessage 
      }, null, 2), 
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }
}

// Generate alt-text using Workers AI and store in D1
// Now accepts ArrayBuffer instead of R2ObjectBody
async function generateAndStoreAltText(
  imageKey: string, 
  imageBytes: ArrayBuffer, 
  env: Env
): Promise<void> {
  try {
    // Call Workers AI with the image bytes
    const aiResponse: any = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: Array.from(new Uint8Array(imageBytes)),
      prompt: 'Describe this image in one concise sentence for accessibility purposes.',
      max_tokens: 100,
    });

    const altText = aiResponse.description || 'Image description unavailable';

    // Update D1 record
    await env.DB.prepare(
      'UPDATE images SET alt_text = ?, updated_at = datetime("now") WHERE image_key = ?'
    )
      .bind(altText, imageKey)
      .run();

    console.log(`✅ Stored alt-text for ${imageKey}: ${altText}`);
  } catch (error) {
    console.error(`❌ Failed to generate alt-text for ${imageKey}:`, error);
  }
}

// Audit endpoint - list all images with metadata
async function handleAudit(
  env: Env, 
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!env.DB) {
    return new Response(
      JSON.stringify({ 
        error: 'D1 database binding not configured' 
      }, null, 2), 
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }

  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM images ORDER BY created_at DESC'
    ).all<ImageMetadata>();

    return new Response(
      JSON.stringify({ 
        images: results || [], 
        count: results?.length || 0 
      }, null, 2), 
      {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  } catch (error) {
    console.error('Audit query failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ 
        error: 'Audit failed', 
        details: errorMessage 
      }, null, 2), 
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }
}

// Ingest new image from external URL
async function handleIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await request.json()) as { url: string; key?: string };
    const { url, key } = body;

    if (!url) {
      return new Response(
        JSON.stringify({ 
          error: 'URL required',
          example: { url: 'https://example.com/image.jpg', key: 'optional-name.jpg' }
        }, null, 2), 
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // Fetch image from external URL
    const imageResponse = await fetch(url);
    if (!imageResponse.ok) {
      return new Response(
        JSON.stringify({ 
          error: 'Failed to fetch image from URL',
          status: imageResponse.status 
        }, null, 2), 
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    const contentType = imageResponse.headers.get('Content-Type') || 'application/octet-stream';
    
    // Validate it's an image
    if (!contentType.startsWith('image/')) {
      return new Response(
        JSON.stringify({ 
          error: 'URL does not point to an image',
          received_type: contentType 
        }, null, 2), 
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    const imageKey = key || `ingested-${Date.now()}.${contentType.split('/')[1]}`;

    // Upload to R2
    await env.IMAGE_BUCKET.put(imageKey, imageResponse.body, {
      httpMetadata: { contentType },
    });

    // Insert into D1
    await env.DB.prepare('INSERT INTO images (image_key, content_type) VALUES (?, ?)')
      .bind(imageKey, contentType)
      .run();

    console.log(`✅ Ingested image: ${imageKey}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        image_key: imageKey,
        url: `/images/${imageKey}`
      }, null, 2), 
      {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  } catch (error) {
    console.error('Ingestion error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ 
        error: 'Ingestion failed', 
        details: errorMessage 
      }, null, 2), 
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }
}