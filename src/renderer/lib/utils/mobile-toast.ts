import { toastController, type ToastOptions } from '@ionic/vue'

const MOBILE_TAB_BAR_ANCHOR_ID = 'mobile-tab-bar'
const DEFAULT_TOAST_DURATION = 2000

const normalizeCssClass = (cssClass: ToastOptions['cssClass']): string[] => {
  if (!cssClass) return []
  return Array.isArray(cssClass)
    ? cssClass
    : cssClass.split(' ').filter(Boolean)
}

const isVisibleElement = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  )
}

const resolveVisibleAnchor = (
  positionAnchor: ToastOptions['positionAnchor']
): HTMLElement | undefined => {
  if (!positionAnchor || typeof document === 'undefined') return undefined

  const element = typeof positionAnchor === 'string'
    ? document.getElementById(positionAnchor)
    : positionAnchor

  return element instanceof HTMLElement && isVisibleElement(element)
    ? element
    : undefined
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
    positionAnchor,
    ...restOptions
  } = options
  const resolvedAnchor = position === 'middle'
    ? undefined
    : resolveVisibleAnchor(positionAnchor ?? MOBILE_TAB_BAR_ANCHOR_ID)
  const toastOptions: ToastOptions = {
    ...restOptions,
    message,
    duration,
    position,
    cssClass: [
      'mobile-toast',
      isSuccess ? 'mobile-toast-success' : undefined,
      ...normalizeCssClass(cssClass)
    ].filter(Boolean) as string[]
  }

  if (resolvedAnchor) {
    toastOptions.positionAnchor = resolvedAnchor
  }

  if (!isSuccess) {
    toastOptions.color = color
  }

  const toast = await toastController.create(toastOptions)

  await toast.present()
  return toast
}
