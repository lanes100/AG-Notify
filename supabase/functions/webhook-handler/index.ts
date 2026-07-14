import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ""

const LEMON_SQUEEZY_SECRET = Deno.env.get('LEMON_SQUEEZY_WEBHOOK_SECRET') || ""
const PATREON_SECRET = Deno.env.get('PATREON_WEBHOOK_SECRET') || ""
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') || ""

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Helper to generate a key matching validation: sum(charCodes) % 10 === 7
function generateLicenseKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  while (true) {
    let block1 = '';
    let block2 = '';
    for (let i = 0; i < 4; i++) {
      block1 += chars.charAt(Math.floor(Math.random() * chars.length));
      block2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    let sum = 0;
    for (let i = 0; i < block1.length; i++) {
      sum += block1.charCodeAt(i);
    }
    for (let i = 0; i < block2.length; i++) {
      sum += block2.charCodeAt(i);
    }
    if (sum % 10 === 7) {
      return `AGN-${block1}-${block2}`;
    }
  }
}

// Convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes.set([parseInt(hex.substring(i, i + 2), 16)], i / 2);
  }
  return bytes;
}

// Verify HMAC-SHA256 signature
async function verifyHmac(secret: string, signature: string, rawBody: string): Promise<boolean> {
  if (!secret || !signature) return false;
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify", "sign"]
  );

  const signatureBytes = hexToBytes(signature);
  const dataBytes = encoder.encode(rawBody);

  return await crypto.subtle.verify("HMAC", key, signatureBytes, dataBytes);
}

// Send email with license key via Brevo
async function sendLicenseEmail(email: string, licenseKey: string): Promise<boolean> {
  if (!BREVO_API_KEY) {
    console.warn("Brevo API Key is not set. Skipping email delivery.");
    return false;
  }

  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          name: "AG Chat Notifications Premium",
          email: "myshopandmyl1fe@gmail.com"
        },
        to: [
          {
            email: email
          }
        ],
        subject: "Your AG Chat Notifications Premium License Key! 🔑",
        htmlContent: `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2>Thank you for supporting AG Chat Notifications! 💖</h2>
            <p>Your premium status has been successfully registered. Here is your license key to unlock all premium features and sounds:</p>
            <div style="background: #f1f1f7; padding: 15px; border-radius: 6px; font-family: monospace; font-size: 18px; font-weight: bold; letter-spacing: 1px; display: inline-block; margin: 10px 0;">
              ${licenseKey}
            </div>
            <p><strong>Instructions:</strong></p>
            <ol>
              <li>Open VS Code.</li>
              <li>Open the AG Chat Notifications Dashboard or press <code>Ctrl+Shift+P</code> and search for <code>AG Chat Notifications: Enter License Key</code>.</li>
              <li>Paste the key above to activate your Premium features instantly!</li>
            </ol>
            <p>If you have any questions or run into issues, feel free to reply to this email.</p>
            <br>
            <p>Best regards,<br>AG Chat Notifications Developer</p>
          </div>
        `
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Failed to send email via Brevo: ${response.status} - ${errText}`);
      return false;
    }

    console.log(`License key successfully emailed to ${email} via Brevo`);
    return true;
  } catch (error) {
    console.error("Error occurred while sending email via Brevo:", error);
    return false;
  }
}

serve(async (req: Request) => {
  const method = req.method
  if (method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } })
  }

  try {
    const rawBody = await req.text()
    
    // Check if it's Lemon Squeezy
    const lsSignature = req.headers.get("x-signature")
    if (lsSignature) {
      const isValid = await verifyHmac(LEMON_SQUEEZY_SECRET, lsSignature, rawBody)
      if (!isValid) {
        return new Response("Invalid Lemon Squeezy signature", { status: 401 })
      }

      const payload = JSON.parse(rawBody)
      const eventName = payload.meta?.event_name
      const email = payload.data?.attributes?.user_email || payload.data?.attributes?.customer_email

      if (!email) {
        return new Response("Email not found in payload", { status: 400 })
      }

      if (eventName === "order_created" || eventName === "subscription_created") {
        // Create new license key
        const newKey = generateLicenseKey()
        const { error } = await supabase
          .from("license_keys")
          .insert({
            key: newKey,
            email: email.toLowerCase(),
            max_devices: 2,
            is_active: true
          })

        if (error) throw error

        // Automatically email key to user
        await sendLicenseEmail(email.toLowerCase(), newKey)

        return new Response(JSON.stringify({ success: true, key: newKey }), {
          headers: { "Content-Type": "application/json" }
        })
      }

      if (eventName === "subscription_expired" || eventName === "subscription_cancelled" || eventName === "subscription_payment_failed") {
        // Disable keys for this email
        const { error } = await supabase
          .from("license_keys")
          .update({ is_active: false })
          .eq("email", email.toLowerCase())

        if (error) throw error

        return new Response(JSON.stringify({ success: true, message: "Subscription deactivated" }), {
          headers: { "Content-Type": "application/json" }
        })
      }

      return new Response("Lemon Squeezy event ignored", { status: 200 })
    }

    // Check if it's Patreon
    const patreonSignature = req.headers.get("x-patreon-signature")
    if (patreonSignature) {
      const isValid = await verifyHmac(PATREON_SECRET, patreonSignature, rawBody)
      if (!isValid) {
        return new Response("Invalid Patreon signature", { status: 401 })
      }

      const payload = JSON.parse(rawBody)
      const eventName = req.headers.get("x-patreon-event")
      const email = payload.data?.attributes?.email

      if (!email) {
        return new Response("Email not found in Patreon payload", { status: 400 })
      }

      if (eventName === "members:create" || eventName === "members:update") {
        const status = payload.data?.attributes?.patron_status // "active_patron", "declined_patron", etc.
        const isActive = status === "active_patron"

        // Check if key already exists for this email
        const { data: existingKeys } = await supabase
          .from("license_keys")
          .select("key")
          .eq("email", email.toLowerCase())

        if (existingKeys && existingKeys.length > 0) {
          // Update active status
          const { error } = await supabase
            .from("license_keys")
            .update({ is_active: isActive })
            .eq("email", email.toLowerCase())
          if (error) throw error
        } else if (isActive) {
          // Create new key
          const newKey = generateLicenseKey()
          const { error } = await supabase
            .from("license_keys")
            .insert({
              key: newKey,
              email: email.toLowerCase(),
              max_devices: 2,
              is_active: true
            })
          if (error) throw error

          // Email key to user
          await sendLicenseEmail(email.toLowerCase(), newKey)
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        })
      }

      if (eventName === "members:delete") {
        const { error } = await supabase
          .from("license_keys")
          .update({ is_active: false })
          .eq("email", email.toLowerCase())
        if (error) throw error

        return new Response(JSON.stringify({ success: true, message: "Patreon member deleted" }), {
          headers: { "Content-Type": "application/json" }
        })
      }

      return new Response("Patreon event ignored", { status: 200 })
    }

    return new Response("Unsupported webhook provider", { status: 400 })

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    })
  }
})
