/**
 * CRM Integration Tool Templates
 * 
 * Pre-built tool configurations for common CRM integrations.
 * Users select a template, fill in their API key/URL, and the
 * tool is auto-configured with the correct parameters, endpoint, and auth.
 */

export const TOOL_TEMPLATES = [
  // ─── Customer Lookup ─────────────────────────────────
  {
    id: 'lookup_customer',
    name: 'lookup_customer',
    category: 'CRM',
    icon: '🔍',
    label: 'Lookup Customer',
    description: 'Look up a customer in your CRM by phone number, email, or name. Returns their profile, account info, and recent interactions.',
    suggestedPrompt: 'When a caller identifies themselves or you have their phone number, use this tool to look up their customer profile before proceeding.',
    defaultConfig: {
      httpMethod: 'GET',
      authType: 'bearer',
      endpointUrl: 'https://your-crm.com/api/contacts?phone={{phone_number}}',
      parameters: {
        type: 'object',
        properties: {
          phone_number: {
            type: 'string',
            description: 'The caller phone number in E.164 format (e.g., +919876543210)',
          },
          email: {
            type: 'string',
            description: 'Customer email address (optional alternative lookup)',
          },
        },
        required: ['phone_number'],
      },
    },
    examples: {
      hubspot: 'https://api.hubapi.com/crm/v3/objects/contacts/search',
      salesforce: 'https://your-instance.salesforce.com/services/data/v58.0/query/?q=SELECT+Name,Phone+FROM+Contact+WHERE+Phone=\'{{phone_number}}\'',
      zoho: 'https://www.zohoapis.com/crm/v5/Contacts/search?phone={{phone_number}}',
    },
  },

  // ─── Create Support Ticket ───────────────────────────
  {
    id: 'create_ticket',
    name: 'create_ticket',
    category: 'Support',
    icon: '🎫',
    label: 'Create Support Ticket',
    description: 'Create a new support ticket in your helpdesk system. Include the issue description, priority, and caller details.',
    suggestedPrompt: 'If the caller has a problem that needs follow-up, create a support ticket and share the ticket number with them.',
    defaultConfig: {
      httpMethod: 'POST',
      authType: 'api_key',
      endpointUrl: 'https://your-helpdesk.com/api/v2/tickets',
      parameters: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'Brief one-line summary of the issue',
          },
          description: {
            type: 'string',
            description: 'Detailed description of the customer issue and what was discussed',
          },
          priority: {
            type: 'string',
            description: 'Ticket priority: low, medium, high, or urgent',
          },
          customer_name: {
            type: 'string',
            description: 'Name of the customer',
          },
          customer_phone: {
            type: 'string',
            description: 'Phone number of the customer',
          },
        },
        required: ['subject', 'description'],
      },
    },
    examples: {
      freshdesk: 'https://your-domain.freshdesk.com/api/v2/tickets',
      zendesk: 'https://your-subdomain.zendesk.com/api/v2/tickets.json',
      jira: 'https://your-domain.atlassian.net/rest/api/3/issue',
    },
  },

  // ─── Check Order Status ──────────────────────────────
  {
    id: 'check_order_status',
    name: 'check_order_status',
    category: 'E-Commerce',
    icon: '📦',
    label: 'Check Order Status',
    description: 'Look up the status of an order by order ID or tracking number. Returns shipping status, ETA, and tracking info.',
    suggestedPrompt: 'When the caller asks about their order, ask for their order number and use this tool to check the current status.',
    defaultConfig: {
      httpMethod: 'GET',
      authType: 'bearer',
      endpointUrl: 'https://your-shop.com/api/orders/{{order_id}}',
      parameters: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'The order ID or tracking number',
          },
        },
        required: ['order_id'],
      },
    },
    examples: {
      shopify: 'https://your-store.myshopify.com/admin/api/2024-01/orders/{{order_id}}.json',
      woocommerce: 'https://your-site.com/wp-json/wc/v3/orders/{{order_id}}',
    },
  },

  // ─── Schedule Appointment ────────────────────────────
  {
    id: 'schedule_appointment',
    name: 'schedule_appointment',
    category: 'Calendar',
    icon: '📅',
    label: 'Schedule Appointment',
    description: 'Book an appointment or meeting for the caller. Specify date, time, purpose, and attendee details.',
    suggestedPrompt: 'If the caller wants to schedule a meeting or appointment, collect their preferred date, time, and purpose, then use this tool to book it.',
    defaultConfig: {
      httpMethod: 'POST',
      authType: 'bearer',
      endpointUrl: 'https://your-calendar.com/api/appointments',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Appointment date in YYYY-MM-DD format',
          },
          time: {
            type: 'string',
            description: 'Appointment time in HH:MM 24-hour format',
          },
          duration_minutes: {
            type: 'number',
            description: 'Duration in minutes (default 30)',
          },
          purpose: {
            type: 'string',
            description: 'Purpose or agenda of the appointment',
          },
          attendee_name: {
            type: 'string',
            description: 'Name of the person attending',
          },
          attendee_phone: {
            type: 'string',
            description: 'Phone number of the attendee',
          },
        },
        required: ['date', 'time', 'purpose', 'attendee_name'],
      },
    },
    examples: {
      calendly: 'https://api.calendly.com/scheduled_events',
      googleCalendar: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    },
  },

  // ─── Update CRM Contact ─────────────────────────────
  {
    id: 'update_crm_contact',
    name: 'update_crm_contact',
    category: 'CRM',
    icon: '📝',
    label: 'Update CRM Contact',
    description: 'Update a contact record in your CRM with new information gathered during the call (notes, preferences, tags, etc.).',
    suggestedPrompt: 'After gathering new information from the caller (updated email, preferences, etc.), use this tool to update their CRM record.',
    defaultConfig: {
      httpMethod: 'PUT',
      authType: 'bearer',
      endpointUrl: 'https://your-crm.com/api/contacts/{{contact_id}}',
      parameters: {
        type: 'object',
        properties: {
          contact_id: {
            type: 'string',
            description: 'The CRM contact ID to update',
          },
          notes: {
            type: 'string',
            description: 'Call notes or summary to add to the contact record',
          },
          tags: {
            type: 'string',
            description: 'Comma-separated tags to add (e.g., "hot-lead,callback-requested")',
          },
          custom_fields: {
            type: 'string',
            description: 'JSON string of custom field updates (e.g., {"preferred_language": "Hindi"})',
          },
        },
        required: ['contact_id', 'notes'],
      },
    },
    examples: {
      hubspot: 'https://api.hubapi.com/crm/v3/objects/contacts/{{contact_id}}',
      salesforce: 'https://your-instance.salesforce.com/services/data/v58.0/sobjects/Contact/{{contact_id}}',
    },
  },

  // ─── Send SMS / Follow-up ────────────────────────────
  {
    id: 'send_sms',
    name: 'send_sms',
    category: 'Communication',
    icon: '💬',
    label: 'Send SMS Follow-up',
    description: 'Send an SMS message to the caller with a link, confirmation, or follow-up information.',
    suggestedPrompt: 'If you need to share a link, confirmation number, or detailed information the caller can reference later, use this tool to send them an SMS.',
    defaultConfig: {
      httpMethod: 'POST',
      authType: 'bearer',
      endpointUrl: 'https://your-sms-provider.com/api/messages',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Phone number to send SMS to (in E.164 format)',
          },
          message: {
            type: 'string',
            description: 'The SMS message text to send (max 160 chars recommended)',
          },
        },
        required: ['to', 'message'],
      },
    },
    examples: {
      twilio: 'https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json',
    },
  },

  // ─── Check Availability ──────────────────────────────
  {
    id: 'check_availability',
    name: 'check_availability',
    category: 'Calendar',
    icon: '⏰',
    label: 'Check Availability',
    description: 'Check available time slots for a specific date. Returns a list of open slots the caller can choose from.',
    suggestedPrompt: 'When the caller wants to book a meeting, first use this tool to check available slots, then present the options to the caller.',
    defaultConfig: {
      httpMethod: 'GET',
      authType: 'bearer',
      endpointUrl: 'https://your-calendar.com/api/availability?date={{date}}',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Date to check availability for (YYYY-MM-DD format)',
          },
        },
        required: ['date'],
      },
    },
    examples: {
      calendly: 'https://api.calendly.com/event_types/{event_type_uuid}/available_times',
    },
  },

  // ─── Process Payment ─────────────────────────────────
  {
    id: 'process_payment',
    name: 'process_payment',
    category: 'Billing',
    icon: '💳',
    label: 'Process Payment',
    description: 'Process a payment or check payment status. Can handle invoice lookup, balance inquiries, and payment confirmation.',
    suggestedPrompt: 'If the caller wants to check their balance or payment status, use this tool. Never ask for full card numbers over phone — use account/invoice IDs instead.',
    defaultConfig: {
      httpMethod: 'POST',
      authType: 'bearer',
      endpointUrl: 'https://your-billing.com/api/payments',
      parameters: {
        type: 'object',
        properties: {
          account_id: {
            type: 'string',
            description: 'Customer account or invoice ID',
          },
          action: {
            type: 'string',
            description: 'Action: "check_balance", "payment_status", or "send_invoice"',
          },
        },
        required: ['account_id', 'action'],
      },
    },
    examples: {
      stripe: 'https://api.stripe.com/v1/invoices',
    },
  },
];

/**
 * Get templates grouped by category.
 */
export function getTemplatesByCategory() {
  const groups = {};
  for (const t of TOOL_TEMPLATES) {
    if (!groups[t.category]) groups[t.category] = [];
    groups[t.category].push(t);
  }
  return groups;
}
