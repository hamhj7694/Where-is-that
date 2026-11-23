import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PipelineFlowMap } from './features/pipeline/PipelineFlowMap'

const container = document.getElementById('flow-react-root')

if (container) {
  createRoot(container).render(
    <StrictMode>
      <PipelineFlowMap />
    </StrictMode>,
  )
}
