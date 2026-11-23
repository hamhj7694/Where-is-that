import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  buildFlowGraph,
  type FlowNodeDetail,
  type PipelineAlgorithm,
} from './flow-map-data'
import './pipeline-flow.css'

function FlowStepNode({ data, selected }: NodeProps<Node<FlowNodeDetail>>) {
  return (
    <div
      className={'flow-step lane-' + data.lane + (selected ? ' is-selected' : '')}
      role="button"
      tabIndex={0}
      aria-label={`${data.step} ${data.title}`}
    >
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-step__top">
        <span className="flow-step__step">{data.step}</span>
        <span className="flow-step__lane">{data.laneLabel}</span>
      </div>
      <div className="flow-step__title">{data.title}</div>
      <div className="flow-step__role">{data.role}</div>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  )
}

function LaneLabelNode({ data }: NodeProps) {
  return <div className="flow-lane-label">{String(data.label ?? '')}</div>
}

const nodeTypes = { flowStep: FlowStepNode, laneLabel: LaneLabelNode }

/** 상세 패널이 선택 상태를 다시 그릴 때 쓰는 이벤트 이름. */
const FLOW_NODE_SELECT = 'pipeline-node-select'

export function PipelineFlowMap() {
  const [algorithms, setAlgorithms] = useState<PipelineAlgorithm[]>([])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const flowRef = useRef<ReactFlowInstance<Node> | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/pipeline/algorithms')
      .then(response => {
        if (!response.ok) throw new Error('알고리즘 목록을 읽지 못했어요.')
        return response.json()
      })
      .then(data => {
        if (alive) setAlgorithms(data.items || [])
      })
      .catch(() => {
        if (alive) setAlgorithms([])
      })
    return () => {
      alive = false
    }
  }, [])

  const graph = useMemo(() => buildFlowGraph(algorithms), [algorithms])

  // 알고리즘 목록이 도착하면 그래프를 다시 만들고, 사용자가 옮긴 노드는 클릭 때마다 유지한다.
  useEffect(() => {
    setNodes(graph.nodes)
  }, [graph.nodes, setNodes])

  // E 줄은 비동기로 채워지므로 노드가 늘어난 뒤 한 번 더 화면에 맞춘다.
  useEffect(() => {
    if (!algorithms.length) return
    let timer = 0
    const fit = () => {
      if (!flowRef.current) {
        timer = window.setTimeout(fit, 100)
        return
      }
      timer = window.setTimeout(() => {
        flowRef.current?.fitView({ padding: 0.12, duration: 200 })
      }, 200)
    }
    fit()
    return () => window.clearTimeout(timer)
  }, [algorithms.length])

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    if (node.type !== 'flowStep') return
    setNodes(current => current.map(item => ({ ...item, selected: item.id === node.id })))
    window.dispatchEvent(new CustomEvent(FLOW_NODE_SELECT, { detail: node.data }))
  }, [setNodes])

  return (
    <div className="flow-react-canvas" id="flow-react-canvas">
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        onInit={instance => {
          flowRef.current = instance
        }}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.25}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#2a3a52" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          position="bottom-left"
          nodeColor={node => (node.type === 'laneLabel' ? '#243449' : '#3f6f8f')}
          maskColor="rgba(10,16,26,.72)"
        />
      </ReactFlow>
    </div>
  )
}
