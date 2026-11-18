import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'

interface Props { open: boolean; title: string; onClose: () => void; children: ReactNode; focusKey: string; className?: string; initialFocus?: RefObject<HTMLElement | null>; footer?: ReactNode; descriptionId?: string }

export default function Modal({ open, title, onClose, children, focusKey, className = '', initialFocus, footer, descriptionId }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
    if (open) (initialFocus?.current ?? element.querySelector<HTMLButtonElement>('button'))?.focus()
  }, [open, focusKey, initialFocus])

  return <dialog ref={dialog} className={`modal ${className}`} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => {
      // File inputs also emit a bubbling cancel when their picker is dismissed.
      if (event.target !== event.currentTarget) return
      event.preventDefault(); onClose()
    }}
    onClick={(event) => { if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    } }}>
    <div className="modal__heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X /></button></div>
    <div className="modal__body">{children}</div>
    {footer && <div className="modal__footer">{footer}</div>}
  </dialog>
}
