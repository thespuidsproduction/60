/**
 * Brand strings live here and nowhere else (dev bible §140).
 * Source modules and package names stay generic so the product can be renamed
 * by changing environment configuration, not code.
 */
export interface Brand {
  productName: string
  emailSenderName: string
  supportEmail: string
}

export function loadBrand(env: Record<string, string | undefined> = process.env): Brand {
  const productName = env.BRAND_PRODUCT_NAME ?? "170tarv"
  return {
    productName,
    emailSenderName: env.BRAND_EMAIL_SENDER_NAME ?? productName,
    supportEmail: env.BRAND_SUPPORT_EMAIL ?? "support@example.invalid",
  }
}
