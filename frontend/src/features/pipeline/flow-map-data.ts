import { Position, type Edge, type Node, type NodeHandle } from '@xyflow/react'

/** /api/pipeline/algorithms 항목에서 화면이 쓰는 최소 필드. */
export interface PipelineAlgorithm {
  id: string
  kind: string
  title: string
  summary: string
  pipeline: string
  input: string[]
  steps: string[]
  output: string | string[]
  rules: { label: string; value: string }[]
  code: string[]
  failure: string
  related: string[]
  scopes: string[]
}

/** 노드 클릭 상세 패널로 넘기는 데이터 (기존 index.html의 FLOW_GROUPS 노드와 같은 모양). */
export interface FlowNodeDetail extends Record<string, unknown> {
  id: string
  step: string
  title: string
  page: string
  role: string
  input: string
  output: string
  algo?: string
  pipeline?: string
  scopes?: string[]
  steps?: string[]
  lane: string
  laneLabel: string
}

const FLOW_LANES = [
  {
    id: 'gallery',
    label: 'A · 갤러리에서 찾기',
    nodes: [
      { id: 'a1', step: 'A1', title: '사진 연결·준비', page: 'gallery-prepare', algo: 'algo-gallery-compare', role: '브라우저에서 사진을 고르고 중복을 제거해 참고 사진을 만든다.', input: '기기의 사진·폴더', output: '중복 제거된 참고 사진' },
      { id: 'a2', step: 'A2', title: '사진 유사도 비교 (AI)', page: 'gallery-compare', algo: 'algo-gallery-compare', role: '참고 사진을 설명하고 후보 사진을 한 번에 채점한 뒤 ID를 검증한다.', input: '참고 사진·검색 문장·후보 사진', output: '종합·이미지·맥락 3축 점수' },
      { id: 'a3', step: 'A3', title: '결과 표시', page: 'gallery-result', algo: 'model-similarity', role: '3축 점수로 정렬해 종합/이미지/맥락 화면에 보여준다.', input: '3축 점수와 갤러리 사진', output: '정렬된 사진 카드' },
    ],
  },
  {
    id: 'lost',
    label: 'B · 물건 찾기',
    nodes: [
      { id: 'b1', step: 'B1', title: '조건 정리 + 공개 수집', page: 'lost-prepare', algo: 'algo-query-interpret', role: '자연어에서 탐색어·기간·시각 특징을 뽑고 공개 정보를 모은다.', input: '검색 문장·참고 사진·필터', output: 'AiSearchPlan + 공개 후보' },
      { id: 'b2', step: 'B2', title: '사진 특징 매칭 (AI)', page: 'lost-visual', algo: 'algo-visual-match', role: '웹 참고를 거쳐 공개 사진을 AI가 직접 보고 특징 점수를 매긴다.', input: 'imageFeatures·참고 사진·공개 사진', output: 'visualScore와 사진 특징 배지' },
      { id: 'b3', step: 'B3', title: '맥락 재정렬 + 결과', page: 'lost-context', algo: 'algo-context-rank', role: '설명·장소 맥락으로 후보를 다시 줄 세우고 확정 영역에 표시한다.', input: '후보 전체·사용자 문장', output: '관련도 순 3채널 결과' },
    ],
  },
  {
    id: 'direct',
    label: 'C · 직접 찾기',
    nodes: [
      { id: 'c1', step: 'C1', title: '검색어 조건 정리 (AI)', page: 'direct-prepare', algo: 'algo-query-interpret', role: '말 속 고유명사·색상·기간을 탐색어와 필터로 바꾼다.', input: '검색 문장·오늘 날짜', output: 'apiKeywords·include·기간 필터' },
      { id: 'c2', step: 'C2', title: '코드 필터·백그라운드 스캔', page: 'direct-browse', algo: 'algo-code-filter', role: '공식 코드로 먼저 좁히고 서버가 사진을 8장씩 이어서 분석한다.', input: '필터·검색 조건·jobId', output: '진행률과 전체 후보 풀' },
      { id: 'c3', step: 'C3', title: '등급별 결과 표시', page: 'direct-result', algo: 'algo-ranking', role: '등급 → 텍스트·사진 점수 → 최신순으로 정렬해 페이지를 만든다.', input: '등급·점수·습득일', output: '등급 배지가 붙은 결과 목록' },
    ],
  },
  {
    id: 'common',
    label: 'D · 공통 / 점검',
    nodes: [
      { id: 'd0', step: 'D0', title: '인터넷 참고·임베딩', page: 'common-web', algo: 'algo-web-reference', role: '모르는 고유명사를 웹에서 조사해 설명과 참고 사진을 만든다.', input: '고유명사', output: '보강된 특징·참고 사진' },
      { id: 'd1', step: 'D1', title: '캐시·비밀값·헬스', page: 'common-base', algo: '', pipeline: 'audit', scopes: ['전체', '캐시', '비밀값', '헬스'], role: '검색 캐시와 헬스 확인, 키·토큰을 브라우저에 노출하지 않는 경계를 맡는다.', input: '검색 응답·서버 설정', output: '캐시된 응답·헬스 상태', steps: ['검색 300초·상세 24시간·지도 30일 캐시를 적용한다.', '/api/health와 /health가 같은 상태를 돌려준다.', '키·토큰은 서버 환경 변수에만 두고 응답에 담지 않는다.'] },
    ],
  },
] as const

/** 공통 단계(D0)가 사진 분석 단계로 들어가는 보조 경로. */
const COMMON_LINKS: [string, string][] = [['d0', 'b2'], ['d0', 'c2']]

const NODE_WIDTH = 208
const NODE_HEIGHT = 104
const GAP_X = 68
const LANE_GAP_Y = 72
const LANE_LABEL_WIDTH = 196

/**
 * React Flow는 핸드북 바운드가 있어야 엣지를 만든다. 확인실은 정적 DAG라서
 * DOM 측정에 맡기지 않고 핸들 위치를 직접 선언해 항상 선이 보이게 한다.
 */
const STEP_HANDLES: NodeHandle[] = [
  { type: 'target', position: Position.Left, x: 0, y: NODE_HEIGHT / 2, width: 1, height: 1 },
  { type: 'source', position: Position.Right, x: NODE_WIDTH - 1, y: NODE_HEIGHT / 2, width: 1, height: 1 },
]

function algorithmNodes(algorithms: PipelineAlgorithm[]) {
  return algorithms.map(algo => ({
    id: 'algo-' + algo.id,
    step: algo.kind,
    title: algo.title,
    page: 'algo-detail',
    algo: algo.id,
    role: algo.summary,
    input: (algo.input || []).join(' · '),
    output: Array.isArray(algo.output) ? algo.output.join(' · ') : (algo.output || ''),
  }))
}

/** React Flow 노드·엣지를 한 번에 만든다. 레인 안에서는 순서대로, D0은 보조 점선으로 연결한다. */
export function buildFlowGraph(algorithms: PipelineAlgorithm[]): {
  nodes: Node[]
  edges: Edge[]
} {
  const lanes = [
    ...FLOW_LANES.map(lane => ({ id: lane.id, label: lane.label, nodes: [...lane.nodes] })),
    { id: 'algorithms', label: 'E · 개별 AI 모델 / 검색 방식 / 알고리즘', nodes: algorithmNodes(algorithms) },
  ]

  const nodes: Node[] = []
  const edges: Edge[] = []
  let top = 0

  lanes.forEach(lane => {
    const rowHeight = NODE_HEIGHT + 36
    // E 줄은 순서가 있는 흐름이 아니라 개별 모델·알고리즘 목록이므로 격자로 배치한다.
    const isCatalog = lane.id === 'algorithms'
    const columns = isCatalog ? 4 : lane.nodes.length
    const rows = Math.max(1, Math.ceil(lane.nodes.length / columns))
    nodes.push({
      id: 'lane-' + lane.id,
      type: 'laneLabel',
      position: { x: 0, y: top + 26 },
      data: { label: lane.label, lane: lane.id },
      draggable: false,
      selectable: false,
      connectable: false,
      width: LANE_LABEL_WIDTH,
      height: 28,
      measured: { width: LANE_LABEL_WIDTH, height: 28 },
    })

    lane.nodes.forEach((raw, index) => {
      const detail: FlowNodeDetail = {
        ...raw,
        lane: lane.id,
        laneLabel: lane.label,
      } as FlowNodeDetail
      const position = {
        x: LANE_LABEL_WIDTH + (isCatalog ? index % columns : index) * (NODE_WIDTH + GAP_X),
        y: top + (isCatalog ? Math.floor(index / columns) : 0) * rowHeight,
      }
      nodes.push({
        id: detail.id,
        type: 'flowStep',
        position,
        data: detail,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
        handles: STEP_HANDLES,
      })
      if (!isCatalog && index > 0) {
        edges.push({
          id: `${lane.id}-${lane.nodes[index - 1].id}-${detail.id}`,
          source: lane.nodes[index - 1].id,
          target: detail.id,
          type: 'smoothstep',
          animated: true,
          className: 'edge-main',
        })
      }
    })

    top += rows * rowHeight + LANE_GAP_Y
  })

  COMMON_LINKS.forEach(([source, target]) => {
    edges.push({
      id: `common-${source}-${target}`,
      source,
      target,
      type: 'smoothstep',
      animated: true,
      className: 'edge-common',
      style: { stroke: '#7dd3fc', strokeDasharray: '6 4' },
    })
  })

  return { nodes, edges }
}
