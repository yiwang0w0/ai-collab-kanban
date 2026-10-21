package models

import (
	"errors"
	"time"
)

var (
	ErrPoolAdmissionUnavailable    = errors.New("pool_admission_unavailable")
	ErrPoolTaskStartPreparing      = errors.New("pool_task_start_preparing")
	ErrPoolClaimStartConflict      = errors.New("pool_claim_start_conflict")
	ErrPoolLaunchAlreadyAdmitted   = errors.New("pool_launch_already_admitted")
	ErrPoolTaskCapacityUnavailable = errors.New("pool_task_capacity_unavailable")
	ErrReservedPoolEventType       = errors.New("pool_event_type_reserved")
	ErrPoolResourcesUnconfirmed    = errors.New("pool_resources_unconfirmed")
)

const (
	PoolDispatchKeyPrefix  = "pool-dispatch:v1:"
	PoolEventNamespace     = "pool."
	PoolExecutionBound     = "pool.execution-bound.v1"
	PoolWorkObserved       = "pool.work-observed.v1"
	PoolLaunchAdmitted     = "pool.launch-admitted.v1"
	PoolExecutionAllocated = "pool.execution-allocated.v1"
	PoolTurnEnded          = "pool.turn-ended.v1"
	PoolExecutionStopped   = "pool.execution-stopped.v1"
)

// PoolClaimStart 由宿主从实际领取快照提取，不能由用户请求或提示正文签发。
type PoolClaimStart struct {
	RunID   string              `json:"run_id"`
	ClaimID string              `json:"claim_id"`
	Release PoolReleaseSnapshot `json:"pool_release"`
}

// PoolExecutionIdentity 只含宿主执行标识，不保存提示、工具参数或终端正文。
type PoolExecutionIdentity struct {
	RunID              string              `json:"run_id"`
	ClaimID            string              `json:"claim_id"`
	TaskID             string              `json:"task_id"`
	AgentProfileID     string              `json:"agent_profile_id"`
	ExecutionProfileID string              `json:"execution_profile_id"`
	SessionID          string              `json:"session_id"`
	ExecutionID        string              `json:"execution_id"`
	TurnID             string              `json:"turn_id"`
	OperationID        string              `json:"operation_id"`
	OperationSource    PoolOperationSource `json:"operation_source,omitempty"`
	PromptGeneration   int64               `json:"prompt_generation"`
}

// PoolExecutionAllocation 记录进程前分配，不具有提供商 operation 或开工证明。
type PoolExecutionAllocation struct {
	PoolExecutionIdentity
	AgentType string `json:"agent_type"`
}

type PoolOperationSource string

const (
	PoolOperationProvider PoolOperationSource = "provider"
	PoolOperationHostTurn PoolOperationSource = "host_turn"
)

// PoolExecutionActivity 只由宿主可信传输归一化，不含正文或调用者自报的 run／claim。
type PoolExecutionActivity struct {
	TaskID           string
	AgentProfileID   string
	SessionID        string
	ExecutionID      string
	TurnID           string
	OperationID      string
	PromptGeneration int64
	AgentType        string
	StartedSource    PoolStartSource
}

type PoolStartSource string

const (
	PoolStartCodexProvider PoolStartSource = "codex_provider_turn_started"
	PoolStartAssistant     PoolStartSource = "assistant_activity"
	PoolStartTool          PoolStartSource = "tool_activity"
)

type PoolWorkReceipt struct {
	PoolExecutionIdentity
	StartedSource PoolStartSource `json:"started_source"`
}

type PoolTurnOutcome string

const (
	PoolTurnCompleted PoolTurnOutcome = "completed"
	PoolTurnFailed    PoolTurnOutcome = "failed"
)

// PoolTurnEndReceipt 只证明绑定回合的结果，不证明进程／工作区停止或主卡验收。
type PoolTurnEndReceipt struct {
	PoolExecutionIdentity
	Outcome PoolTurnOutcome `json:"outcome"`
}

// PoolReleaseSnapshot 只由任务系统从当前阶段账本与原生配置读取，不是浏览器请求体。
type PoolReleaseSnapshot struct {
	TaskID         string    `json:"task_id"`
	WorkspaceID    string    `json:"workspace_id"`
	WorkflowID     string    `json:"workflow_id"`
	WorkflowStepID string    `json:"workflow_step_id"`
	EntryID        int64     `json:"entry_id"`
	AgentProfileID string    `json:"agent_profile_id"`
	ActorID        string    `json:"actor_id"`
	ReleasedAt     time.Time `json:"released_at"`
}

// PoolTaskBusyError 携带占用本任务的原生运行，供已授权动作链接到已有工作。
type PoolTaskBusyError struct{ RunID string }

func (e *PoolTaskBusyError) Error() string { return "pool_task_busy: " + e.RunID }
