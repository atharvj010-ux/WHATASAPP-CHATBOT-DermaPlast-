import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { phone, name, email, treatment, date, time } = req.body;

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .single();

  if (customerError && customerError.code !== 'PGRST116') {
    return res.status(500).json({ error: 'Failed to look up customer' });
  }

  let customerId;

  if (customer) {
    customerId = customer.id;
  } else {
    const { data: newCustomer, error: newCustomerError } = await supabase
      .from('customers')
      .insert([{ name, phone, email }])
      .select()
      .single();

    if (newCustomerError) {
      return res.status(500).json({ error: 'Failed to create customer' });
    }

    customerId = newCustomer.id;
  }

  const { data: appointment, error: appointmentError } = await supabase
    .from('appointments')
    .insert([{ customer_id: customerId, treatment, date, time }])
    .select()
    .single();

  if (appointmentError) {
    return res.status(500).json({ error: 'Failed to book appointment' });
  }

  return res.status(200).json({ message: 'Appointment booked!', appointment });
}
