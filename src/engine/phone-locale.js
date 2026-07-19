/**
 * Phone locale — infer country and currency from an E.164 phone number.
 *
 * Longest-prefix match on the international calling code, so the chat
 * agent talks money in the lead's own currency (+91 → ₹, +1 → $, …).
 */

// calling code → [country, currency code, symbol]
const CALLING_CODES = {
  '1': ['United States/Canada', 'USD', '$'],
  '7': ['Russia/Kazakhstan', 'RUB', '₽'],
  '20': ['Egypt', 'EGP', 'E£'],
  '27': ['South Africa', 'ZAR', 'R'],
  '30': ['Greece', 'EUR', '€'],
  '31': ['Netherlands', 'EUR', '€'],
  '32': ['Belgium', 'EUR', '€'],
  '33': ['France', 'EUR', '€'],
  '34': ['Spain', 'EUR', '€'],
  '36': ['Hungary', 'HUF', 'Ft'],
  '39': ['Italy', 'EUR', '€'],
  '40': ['Romania', 'RON', 'lei'],
  '41': ['Switzerland', 'CHF', 'CHF'],
  '43': ['Austria', 'EUR', '€'],
  '44': ['United Kingdom', 'GBP', '£'],
  '45': ['Denmark', 'DKK', 'kr'],
  '46': ['Sweden', 'SEK', 'kr'],
  '47': ['Norway', 'NOK', 'kr'],
  '48': ['Poland', 'PLN', 'zł'],
  '49': ['Germany', 'EUR', '€'],
  '51': ['Peru', 'PEN', 'S/'],
  '52': ['Mexico', 'MXN', 'MX$'],
  '54': ['Argentina', 'ARS', 'AR$'],
  '55': ['Brazil', 'BRL', 'R$'],
  '56': ['Chile', 'CLP', 'CL$'],
  '57': ['Colombia', 'COP', 'CO$'],
  '58': ['Venezuela', 'VES', 'Bs.'],
  '60': ['Malaysia', 'MYR', 'RM'],
  '61': ['Australia', 'AUD', 'A$'],
  '62': ['Indonesia', 'IDR', 'Rp'],
  '63': ['Philippines', 'PHP', '₱'],
  '64': ['New Zealand', 'NZD', 'NZ$'],
  '65': ['Singapore', 'SGD', 'S$'],
  '66': ['Thailand', 'THB', '฿'],
  '81': ['Japan', 'JPY', '¥'],
  '82': ['South Korea', 'KRW', '₩'],
  '84': ['Vietnam', 'VND', '₫'],
  '86': ['China', 'CNY', '¥'],
  '90': ['Turkey', 'TRY', '₺'],
  '91': ['India', 'INR', '₹'],
  '92': ['Pakistan', 'PKR', 'Rs'],
  '93': ['Afghanistan', 'AFN', '؋'],
  '94': ['Sri Lanka', 'LKR', 'Rs'],
  '95': ['Myanmar', 'MMK', 'K'],
  '98': ['Iran', 'IRR', 'IRR'],
  '212': ['Morocco', 'MAD', 'DH'],
  '213': ['Algeria', 'DZD', 'DA'],
  '216': ['Tunisia', 'TND', 'DT'],
  '218': ['Libya', 'LYD', 'LD'],
  '233': ['Ghana', 'GHS', 'GH₵'],
  '234': ['Nigeria', 'NGN', '₦'],
  '251': ['Ethiopia', 'ETB', 'Br'],
  '254': ['Kenya', 'KES', 'KSh'],
  '255': ['Tanzania', 'TZS', 'TSh'],
  '256': ['Uganda', 'UGX', 'USh'],
  '351': ['Portugal', 'EUR', '€'],
  '352': ['Luxembourg', 'EUR', '€'],
  '353': ['Ireland', 'EUR', '€'],
  '354': ['Iceland', 'ISK', 'kr'],
  '356': ['Malta', 'EUR', '€'],
  '357': ['Cyprus', 'EUR', '€'],
  '358': ['Finland', 'EUR', '€'],
  '359': ['Bulgaria', 'BGN', 'лв'],
  '370': ['Lithuania', 'EUR', '€'],
  '371': ['Latvia', 'EUR', '€'],
  '372': ['Estonia', 'EUR', '€'],
  '375': ['Belarus', 'BYN', 'Br'],
  '380': ['Ukraine', 'UAH', '₴'],
  '381': ['Serbia', 'RSD', 'din'],
  '385': ['Croatia', 'EUR', '€'],
  '386': ['Slovenia', 'EUR', '€'],
  '420': ['Czech Republic', 'CZK', 'Kč'],
  '421': ['Slovakia', 'EUR', '€'],
  '852': ['Hong Kong', 'HKD', 'HK$'],
  '853': ['Macau', 'MOP', 'MOP$'],
  '855': ['Cambodia', 'KHR', '៛'],
  '856': ['Laos', 'LAK', '₭'],
  '880': ['Bangladesh', 'BDT', '৳'],
  '886': ['Taiwan', 'TWD', 'NT$'],
  '960': ['Maldives', 'MVR', 'Rf'],
  '961': ['Lebanon', 'LBP', 'L£'],
  '962': ['Jordan', 'JOD', 'JD'],
  '963': ['Syria', 'SYP', 'S£'],
  '964': ['Iraq', 'IQD', 'IQD'],
  '965': ['Kuwait', 'KWD', 'KD'],
  '966': ['Saudi Arabia', 'SAR', 'SR'],
  '967': ['Yemen', 'YER', 'YER'],
  '968': ['Oman', 'OMR', 'OMR'],
  '971': ['United Arab Emirates', 'AED', 'AED'],
  '972': ['Israel', 'ILS', '₪'],
  '973': ['Bahrain', 'BHD', 'BD'],
  '974': ['Qatar', 'QAR', 'QR'],
  '975': ['Bhutan', 'BTN', 'Nu.'],
  '977': ['Nepal', 'NPR', 'Rs'],
  '992': ['Tajikistan', 'TJS', 'SM'],
  '993': ['Turkmenistan', 'TMT', 'm'],
  '994': ['Azerbaijan', 'AZN', '₼'],
  '995': ['Georgia', 'GEL', '₾'],
  '996': ['Kyrgyzstan', 'KGS', 'сом'],
  '998': ['Uzbekistan', 'UZS', "so'm"],
};

// calling code → UTC offset in hours (standard time, approximate — good
// enough for greetings and quiet hours). null = country spans time zones.
const UTC_OFFSETS = {
  '1': null, '7': null, '55': null, '52': null, '61': null, '62': null,
  '20': 2, '27': 2, '30': 2, '31': 1, '32': 1, '33': 1, '34': 1, '36': 1,
  '39': 1, '40': 2, '41': 1, '43': 1, '44': 0, '45': 1, '46': 1, '47': 1,
  '48': 1, '49': 1, '51': -5, '54': -3, '56': -4, '57': -5, '58': -4,
  '60': 8, '63': 8, '64': 12, '65': 8, '66': 7, '81': 9, '82': 9, '84': 7,
  '86': 8, '90': 3, '91': 5.5, '92': 5, '93': 4.5, '94': 5.5, '95': 6.5,
  '98': 3.5, '212': 1, '213': 1, '216': 1, '233': 0, '234': 1, '251': 3,
  '254': 3, '255': 3, '256': 3, '351': 0, '353': 0, '354': 0, '356': 1,
  '357': 2, '358': 2, '359': 2, '370': 2, '371': 2, '372': 2, '375': 3,
  '380': 2, '381': 1, '385': 1, '386': 1, '420': 1, '421': 1, '852': 8,
  '853': 8, '855': 7, '856': 7, '880': 6, '886': 8, '960': 5, '961': 2,
  '962': 3, '963': 3, '964': 3, '965': 3, '966': 3, '967': 3, '968': 4,
  '971': 4, '972': 2, '973': 3, '974': 3, '975': 6, '977': 5.75,
  '992': 5, '993': 5, '994': 4, '995': 4, '996': 6, '998': 5,
};

/**
 * @param {string} phone - E.164-ish number, e.g. "+919149469542"
 * @returns {{ country, currency, symbol, callingCode, utcOffset } | null}
 */
export function getPhoneLocale(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, '');
  // Longest-prefix match: calling codes are 1-3 digits
  for (const len of [3, 2, 1]) {
    const prefix = digits.slice(0, len);
    const hit = CALLING_CODES[prefix];
    if (hit) {
      return {
        country: hit[0], currency: hit[1], symbol: hit[2],
        callingCode: `+${prefix}`,
        utcOffset: UTC_OFFSETS[prefix] ?? null,
      };
    }
  }
  return null;
}

/**
 * The lead's current local hour (0-23), or null if their timezone is unknown.
 */
export function getLocalHour(phone, now = new Date()) {
  const locale = getPhoneLocale(phone);
  if (!locale || locale.utcOffset === null || locale.utcOffset === undefined) return null;
  return Math.floor((((now.getTime() / 3600000) + locale.utcOffset) % 24 + 24) % 24);
}

/**
 * Business-hours guard for automated outreach: if `when` falls outside
 * 10:00-19:00 in the lead's local time, return the next 10:00 local;
 * else return `when`. Unknown timezone → unchanged.
 */
export function deferToWakingHours(phone, when) {
  const locale = getPhoneLocale(phone);
  if (!locale || locale.utcOffset === null || locale.utcOffset === undefined) return when;
  const hoursUtc = when.getTime() / 3600000;
  const localHour = ((hoursUtc + locale.utcOffset) % 24 + 24) % 24;
  if (localHour >= 10 && localHour < 19) return when;
  // Hours to advance to reach 10:00 local
  const delta = (10 - localHour + 24) % 24;
  return new Date(when.getTime() + delta * 3600000);
}
