package models

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ErrPoolRecoveryInvalid      = errors.New("pool_recovery_invalid_request")
	ErrPoolRecoveryConflict     = errors.New("pool_recovery_version_conflict")
	ErrPoolRecoveryConfirmation = errors.New("pool_recovery_human_confirmation_required")
	ErrPoolRecoveryNotFound     = errors.New("pool_recovery_not_found")
)

const (
	PoolRecoveryWithdrawn     = "pool.recovery-withdrawn.v1"
	PoolRecoveryStopRequested = "pool.recovery-stop-requested.v1"
	PoolRecoveryRequeued      = "pool.recovery-requeued.v1"
)

// PoolRecoveryCommand 不接受浏览器自报执行者、停止事实或时间。
type PoolRecoveryCommand struct {
	Action                    string `json:"action"`
	OperationID               string `json:"operation_id"`
	RunID                     string `json:"run_id"`
	ExpectedClaimID           string `json:"expected_claim_id"`
	ExpectedTaskVersion       string `json:"expected_task_version"`
	ExpectedRunVersion        string `json:"expected_run_version"`
	ExpectedManagementVersion string `json:"expected_management_version"`
	Confirm                   bool   `json:"confirm"`
	ConfirmCLIQuota           bool   `json:"confirm_cli_quota"`
}

func (c PoolRecoveryCommand) Valid() bool {
	id, err := uuid.Parse(c.OperationID)
	if err != nil || id == uuid.Nil || id.String() != c.OperationID || !c.Confirm ||
		c.RunID == "" || len(c.RunID) > 256 || strings.TrimSpace(c.RunID) != c.RunID {
		return false
	}
	if c.Action != "withdraw" && c.Action != "stop" && c.Action != "retry" {
		return false
	}
	if c.Action == "withdraw" && c.ExpectedClaimID != "" {
		return false
	}
	if c.Action != "withdraw" && (c.ExpectedClaimID == "" || len(c.ExpectedClaimID) > 256) {
		return false
	}
	if c.Action == "retry" && !c.ConfirmCLIQuota {
		return false
	}
	if _, err := time.Parse(time.RFC3339Nano, c.ExpectedTaskVersion); err != nil {
		return false
	}
	version, err := hex.DecodeString(c.ExpectedRunVersion)
	return err == nil && len(version) == sha256.Size
}

// PoolRecoveryRunVersion 包含原始运行行及最后事件序号，是不透明的比较前提。
func PoolRecoveryRunVersion(run *Run, lastSeq int) string {
	if run == nil || lastSeq < -1 {
		return ""
	}
	encoded, err := json.Marshal(struct {
		Run     *Run
		LastSeq int
	}{run, lastSeq})
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

type PoolRecoveryTaskHeader struct {
	TaskID                 string
	WorkspaceID            string
	Version                string
	Archived               bool
	Ephemeral              bool
	ManagementVersion      string
	ManagementOwnerKind    string
	ManagementOwnerActorID string
}

// PoolRecoveryOperation 保存在原生运行事件内；时刻沿用 RunEvent.CreatedAt。
type PoolRecoveryOperation struct {
	Command     PoolRecoveryCommand   `json:"command"`
	TaskID      string                `json:"task_id"`
	WorkspaceID string                `json:"workspace_id"`
	ActorID     string                `json:"actor_id"`
	EntryID     int64                 `json:"entry_id"`
	Result      string                `json:"result"`
	ClaimID     string                `json:"claim_id,omitempty"`
	FinishedSeq int                   `json:"finished_seq,omitempty"`
	Execution   PoolExecutionIdentity `json:"execution,omitempty"`
}

// ValidExecutionFor 核对恢复控制与原生领取；它不替代实际停止、资源释放或完成凭证。
func (o PoolRecoveryOperation) ValidExecutionFor(request PoolClaimStart) bool {
	validResult := (o.Command.Action == "stop" && o.Result == "stop_requested" && o.FinishedSeq == 0) ||
		(o.Command.Action == "retry" && o.Result == "requeued" && o.FinishedSeq > 0)
	return validResult && o.Command.Valid() && o.Command.RunID == request.RunID &&
		o.Command.ExpectedClaimID == request.ClaimID && o.ClaimID == request.ClaimID &&
		o.Execution.ValidAllocationFor(request) && o.TaskID == request.Release.TaskID &&
		o.WorkspaceID == request.Release.WorkspaceID && o.EntryID == request.Release.EntryID &&
		o.ActorID != "" && len(o.ActorID) <= 256 && strings.TrimSpace(o.ActorID) == o.ActorID
}

type PoolRecoveryActions struct {
	Withdraw bool `json:"withdraw"`
	Stop     bool `json:"stop"`
	Retry    bool `json:"retry"`
}

// PoolRecoveryContext 是确认前提，不替代写入时的权限与事实复核。
type PoolRecoveryContext struct {
	TaskID            string              `json:"task_id"`
	RunID             string              `json:"run_id"`
	EntryID           int64               `json:"entry_id"`
	ClaimID           string              `json:"claim_id"`
	TaskVersion       string              `json:"task_version"`
	RunVersion        string              `json:"run_version"`
	ManagementVersion string              `json:"management_version"`
	Actions           PoolRecoveryActions `json:"actions"`
	Reason            string              `json:"reason,omitempty"`
}

// PoolRecoveryResult 不返回运行输入、内部身份或执行器参数。
type PoolRecoveryResult struct {
	OperationID string    `json:"operation_id"`
	Action      string    `json:"action"`
	TaskID      string    `json:"task_id"`
	RunID       string    `json:"run_id"`
	ClaimID     string    `json:"claim_id"`
	Result      string    `json:"result"`
	RecordedAt  time.Time `json:"recorded_at"`
	EventSeq    int       `json:"event_seq"`
}
