// Package poolview 提供工作区任务池的有界只读视图，不拥有执行状态或调度权。
package poolview

import (
	"errors"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/poolhistory"
)

const (
	stateUnknown = "unknown"
	stateBlocked = "blocked"
)

var (
	ErrInvalidQuery = errors.New("pool_projection_invalid_query")
	ErrUnavailable  = errors.New("pool_projection_unavailable")
)

type Query struct {
	Limit int
	After string
}

type Cursor struct {
	Version     int    `json:"version"`
	WorkspaceID string `json:"workspace_id"`
	AfterTaskID string `json:"after_task_id"`
}

type Card struct {
	WorkspaceID    string            `json:"-" db:"workspace_id"`
	TaskID         string            `json:"task_id" db:"task_id"`
	Title          string            `json:"title" db:"title"`
	WorkflowID     string            `json:"workflow_id" db:"workflow_id"`
	WorkflowStepID string            `json:"workflow_step_id" db:"workflow_step_id"`
	Stage          string            `json:"stage" db:"stage"`
	TaskState      string            `json:"task_state" db:"task_state"`
	PoolExecution  *poolhistory.Item `json:"pool_execution" db:"-"`
	Eligibility    Eligibility       `json:"eligibility" db:"-"`
	Relations      Relations         `json:"relations" db:"-"`
}

type Eligibility struct {
	State  string `json:"state"`
	Reason string `json:"reason"`
}

type Relations struct {
	ParentID       string `json:"parent_id" db:"parent_id"`
	ChildCount     int    `json:"child_count" db:"child_count"`
	DependsOnCount int    `json:"depends_on_count" db:"depends_on_count"`
	BlocksCount    int    `json:"blocks_count" db:"blocks_count"`
}

type CardContext struct {
	Relations           Relations
	DependenciesBlocked bool
	StepExists          bool
	StepUpdatedAt       time.Time
	PoolConfigured      bool
	InvalidPoolConfig   bool
	WIPAdmitted         bool
	QueuedForStep       bool
	Profile             models.PoolExecutionCandidate
}

type Snapshot struct {
	WorkspaceID string
	Cards       []Card
	Histories   map[string]*poolhistory.Snapshot
	Contexts    map[string]CardContext
	HasMore     bool
}

type Page struct {
	WorkspaceID     string `json:"workspace_id"`
	SnapshotVersion string `json:"snapshot_version"`
	Items           []Card `json:"items"`
	NextCursor      string `json:"next_cursor"`
}
