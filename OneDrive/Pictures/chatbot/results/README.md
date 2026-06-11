# WhatsApp Results Images Sharing

Sends three fixed before/after images from `public/results/` to the user who asked.

## Files

| File | Served at |
|------|-----------|
| `43.jpg.jpeg` | `{BASE}/results/43.jpg.jpeg` |
| `44.jpg.jpeg` | `{BASE}/results/44.jpg.jpeg` |
| `45.jpg.jpeg` | `{BASE}/results/45.jpg.jpeg` |

Keep copies in **both**:

- `whatsapp-chatbot/public/results/` (local Express bot)
- `public/results/` (Next.js / Vercel deploy)

## Webhook order (`inbound.js`)

1. Appointment booking  
2. Task creation  
3. **Results images** (this module)  
4. Generic AI agent  

## Trigger phrases

Examples: `Show results`, `Hair transplant results`, `Before after photos`, `PRP results images`, `Can I see results?`

## Env

| Variable | Purpose |
|----------|---------|
| `RESULTS_MEDIA_BASE_URL` | Optional HTTPS app origin (`/api/whatsapp/results/*.jpeg`) |
| `WHATSAPP_RESULT_MEDIA_URLS` | Optional comma-separated image URLs (skip auto-resolve) |
| `PUBLIC_WEBHOOK_URL` | Fallback origin for HTTP media if `RESULTS_MEDIA_BASE_URL` unset |
| `RESULTS_SEND_DELAY_MS` | Delay between image sends (default `450`) |
| `RESULTS_RESEND_COOLDOWN_MS` | Cooldown before resending same category (default `120000`) |

Twilio must be able to **GET** each image URL as `image/*` (not HTML).

**Local dev:** ngrok often returns an HTML warning page to Twilio, so images fail while the text caption still sends. The bot automatically uploads images to **Supabase public storage** (`patient-documents/whatsapp-static-results/`) when HTTP URLs are unreachable.

After deploying, `npm run results:probe https://your-app.vercel.app` should show `OK` for all three files.

## Example flow

User: `Show results`

Bot sends (in order):

1. Image `43.jpg.jpeg`  
2. Image `44.jpg.jpeg`  
3. Image `45.jpg.jpeg`  
4. Caption text  
