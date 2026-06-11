# WhatsApp AI appointment booking

Natural-language booking inserts into `public.appointments` (same table as the CRM Appointment calendar).

## Webhook order (`server.js`)

1. `handleAppointmentBookingFromWhatsApp` — book / reschedule / multi-turn collection
2. `handleTaskCreationFromWhatsApp` — tasks
3. `deliverAiReply` → `runAgent` — static consultation flow, FAQ, etc.

## Env (`whatsapp-chatbot/.env.local`)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role (bypasses RLS for inserts) |
| `SUPABASE_DEFAULT_OWNER_ID` | `owner_id` on new appointments |
| `OPENAI_API_KEY` | Intent parsing |
| `WHATSAPP_DEFAULT_CLINICIAN` | Default `doctor_name` / `clinician` |
| `CLINIC_TIMEZONE` | e.g. `Asia/Kolkata` |
| `CLINIC_BUSINESS_HOURS_JSON` | Optional `{"Mon":{"open":"10:00","close":"20:00"},...}` |
| `APPOINTMENT_DURATION_MINUTES` | Default `30` |
| `APPOINTMENT_SLOT_STEP_MINUTES` | Slot suggestions step, default `30` |

## Overlap SQL (Postgres)

Two intervals overlap when:

```sql
SELECT id, patient_name, scheduled_at, ends_at
FROM appointments
WHERE owner_id = :owner_id
  AND status = 'scheduled'
  AND scheduled_at < :new_ends_at
  AND ends_at > :new_scheduled_at
  AND (doctor_name ILIKE :clinician OR :clinician IS NULL);
```

## Sample log flow

```json
{"channel":"whatsapp-webhook","event":"incoming","bodyPreview":"Book treatment appointment for Aditya Kulkarni on 23 May at 2 PM"}
{"channel":"appointment-handler","event":"appointment_insert_payload","patient_id":"...","scheduled_at":"2026-05-23T08:30:00.000Z"}
{"channel":"appointment-handler","event":"booked","id":"uuid","patientId":"..."}
```

## Example replies

- Success: `✅ Appointment booked for Aditya Kulkarni on 23 May at 2:00 pm`
- Conflict: `❌ 2:00 pm is already booked.` + bullet list of alternate slots
- Missing patient: `❌ Patient "X" not found in CRM.`

## Files

- `parseAppointmentIntent.js` — OpenAI JSON extraction
- `slotAvailability.js` — conflict query + slot suggestions + business hours
- `appointmentHandler.js` — orchestration, session draft, Twilio replies
