import { toastController, type ToastOptions } from '@ionic/vue'

const MOBILE_TAB_BAR_ANCHOR_ID = 'mobile-tab-bar'
const DEFAULT_TOAST_DURATION = 2000

const normalizeCssClass = (cssClass: ToastOptions['cssClass']): string[] => {
  if (!cssClass) return []
  return Array.isArray(cssClass)
    ? cssClass
    : cssClass.split(' ').filter(Boolean)
}

export const presentMobileToast = async (
  message: string,
  color: ToastOptions['color'] = 'success',
  options: Omit<ToastOptions, 'message' | 'color'> = {}
) => {
  const isSuccess = !color || color === 'success'
  const {
    cssClass,
    duration = DEFAULT_TOAST_DURATION,
    position = 'bottom',
    positionAnchor = MOBILE_TAB_BAR_ANCHOR_ID,
    ...restOptions
  } = options

  const toast = await toastController.create({
    ...restOptions,
    message,
    duration,
    position,
    positionAnchor,
    color: isSuccess ? undefined : color,
    cssClass: [
      'mobile-toast',
      isSuccess ? 'mobile-toast-success' : undefined,
      ...normalizeCssClass(cssClass)
    ].filter(Boolean) as string[]
  })

  await toast.present()
  return toast
}
