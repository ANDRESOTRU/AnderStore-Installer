export const isCertificateLimitError = (message: string): boolean =>
  /\bDeveloper error\s+7460\b|\bMaximum number of certificates reached\b/i.test(message);

export const isAppleRateLimitError = (message: string): boolean =>
  /https:\/\/gsa\.apple\.com\//i.test(message) &&
  /\b429\s+Too Many Requests\b/i.test(message);

export const isAnisetteConnectionError = (message: string): boolean =>
  /Failed to get anisette data for login/i.test(message) &&
  /error sending request for url/i.test(message);
