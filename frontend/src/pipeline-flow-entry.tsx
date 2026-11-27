import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PipelineFlowMap } from './features/pipeline/PipelineFlowMap'

const container = document.getElementById('flow-react-root')
const mapPage = document.getElementById('flow-map')

if (container && mapPage) {
  const observer = new MutationObserver(mountWhenVisible)

  function mountWhenVisible() {
    if (!container || !mapPage?.classList.contains('on')) return
    observer.disconnect()
    createRoot(container).render(
      <StrictMode>
        <PipelineFlowMap />
      </StrictMode>,
    )
  }

  observer.observe(mapPage, { attributeFilter: ['class'] })
  mountWhenVisible()
}
