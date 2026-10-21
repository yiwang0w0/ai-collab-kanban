// Package poolhistory 只投影原生池事实，不拥有派发、领取或恢复状态。
package poolhistory

import (
	"errors"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

const (
	MaxItems     = 50
	stateUnknown = "unknown"
)

var (
	ErrInvalidQuery = errors.New("pool_history_invalid_query")
	ErrUnavailable  = errors.New("pool_history_unavailable")
)

type Cursor struct {
	Version   int        `json:"version"`
	TaskID    string     `json:"task_id"`
	EntryID   int64      `json:"entry_id"`
	RunID     string     `json:"run_id,omitempty"`
	ClaimID   string     `json:"claim_id,omitempty"`
	ClaimedAt *time.Time `json:"claimed_at,omitempty"`
}

type Query struct {
	Limit    int
	Before   int64
	Position *Cursor
}

type Page struct {
	TaskID          string `json:"task_id"`
	SnapshotVersion string `json:"snapshot_version"`
	Items           []Item `json:"items"`
	NextCursor      string `json:"next_cursor"`
}

type Item struct {
	EntryID               int64      `json:"entry_id"`
	RunID                 string     `json:"run_id"`
	ClaimID               string     `json:"claim_id"`
	State                 string     `json:"state"`
	Reason                string     `json:"reason,omitempty"`
	PlannedAgentProfileID string     `json:"planned_agent_profile_id"`
	ClaimedAgentProfileID string     `json:"claimed_agent_profile_id"`
	Current               bool       `json:"current"`
	ReleasedAt            *time.Time `json:"released_at"`
	QueuedAt              *time.Time `json:"queued_at"`
	ClaimedAt             *time.Time `json:"claimed_at"`
	StartedAt             *time.Time `json:"started_at"`
	SessionID             string     `json:"session_id"`
	ExecutionID           string     `json:"execution_id"`
	ExecutionProfileID    string     `json:"execution_profile_id"`
	TurnID                string     `json:"turn_id"`
	OperationID           string     `json:"operation_id"`
	OperationSource       string     `json:"operation_source"`
	TurnEndedAt           *time.Time `json:"turn_ended_at"`
	StoppedAt             *time.Time `json:"stopped_at"`
	EndedAt               *time.Time `json:"ended_at"`
	TurnOutcome           string     `json:"turn_outcome,omitempty"`
}

type Entry struct {
	ID              int64     `db:"id"`
	WorkflowID      string    `db:"workflow_id"`
	StepID          string    `db:"step_id"`
	ActorKind       string    `db:"actor_kind"`
	ActorID         string    `db:"actor_id"`
	ContractVersion int       `db:"contract_version"`
	OccurredAt      time.Time `db:"occurred_at"`
	PlannedProfile  string    `db:"planned_profile"`
}

// Snapshot 只含有界原生资料；Run 的提示和其他非身份字段不会被加载或返回。
type Snapshot struct {
	TaskID             string
	WorkspaceID        string
	Entries            []Entry
	Runs               []*runsmodels.Run
	Clearances         []runsmodels.PoolHistoryClearance
	Selections         []Selection
	ClaimCounts        []ClaimCount
	LatestEntryID      int64
	PolicyActivatedAt  time.Time
	CurrentWorkflowID  string
	CurrentStepID      string
	Events             []*runsmodels.RunEvent
	EvidenceIncomplete bool
	HasMore            bool
	Incomplete         bool
}

type Seed struct {
	EntryID int64  `json:"entry_id"`
	RunID   string `json:"run_id"`
}

type Selection struct {
	EntryID     int64      `db:"entry_id"`
	RunID       string     `db:"run_id"`
	ClaimID     string     `db:"claim_id"`
	WorkspaceID string     `db:"workspace_id"`
	ClaimedAt   *time.Time `db:"claimed_at"`
}

type ClaimCount struct {
	RunID          string `db:"run_id"`
	Total          int    `db:"total"`
	CurrentMatches int    `db:"current_matches"`
}
