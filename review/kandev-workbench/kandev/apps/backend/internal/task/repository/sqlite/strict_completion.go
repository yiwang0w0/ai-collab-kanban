package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

const StrictCompletionCriterionID = "fleet.acceptance"

// 严格策略由宿主启动配置指定，插件只能提交校验结果。
type StrictCompletionPolicy struct {
	VerifierID string
	Check      func(context.Context, string, string) error
}

func (r *Repository) SetStrictCompletionPolicy(policy *StrictCompletionPolicy) {
	if policy == nil {
		r.strictCompletionPolicy.Store(nil)
		return
	}
	copy := *policy
	r.strictCompletionPolicy.Store(&copy)
}

func (r *Repository) strictCompletionProtectedTx(ctx context.Context, tx *sql.Tx, taskID string) (bool, error) {
	if r.strictCompletionPolicy.Load() == nil {
		return false, nil
	}
	var ephemeral bool
	if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT is_ephemeral FROM tasks WHERE id = ?`), taskID).Scan(&ephemeral); err != nil {
		return false, err
	}
	return !ephemeral, nil
}

func (r *Repository) strictCompletionActor(exact bool, kind, id string) bool {
	policy := r.strictCompletionPolicy.Load()
	return policy != nil && exact && kind == completionGateActorPlugin &&
		strings.HasPrefix(policy.VerifierID, "plugin:") && id == policy.VerifierID
}

func strictRequiredCriterion(taskID string, criteria []models.TaskCompletionCriterion) *models.TaskCompletionCriterion {
	for i := range criteria {
		item := &criteria[i]
		if item.ID == StrictCompletionCriterionID && item.EvidenceSubject.Kind == models.TaskCompletionEvidenceArtifact && item.EvidenceSubject.ID == taskID {
			return item
		}
	}
	return nil
}

// 只允许指定插件创建或轮换必需条件。其他条件仍沿用宿主原有的人工确认规则。
func (r *Repository) strictCriteriaChangeAllowed(change models.TaskCompletionCriteriaChange, current *models.TaskCompletionGateSnapshot, exact bool) bool {
	if r.strictCompletionPolicy.Load() == nil {
		return true
	}
	next := strictRequiredCriterion(change.TaskID, change.Criteria)
	if next == nil {
		return false
	}
	if r.strictCompletionActor(exact, change.ActorKind, change.ActorID) {
		return true
	}
	previous := strictRequiredCriterion(change.TaskID, current.Criteria)
	return previous != nil && completionCriterionEquivalent(*previous, *next)
}

func (r *Repository) strictCriterionTrusted(taskID string, criterion *models.TaskCompletionCriterion) bool {
	policy := r.strictCompletionPolicy.Load()
	return policy != nil && criterion != nil && criterion.VerifiedRevision == criterion.CriterionRevision &&
		criterion.Evidence != nil && criterion.Evidence.Subject.Kind == models.TaskCompletionEvidenceArtifact &&
		criterion.Evidence.Subject.ID == taskID && criterion.Evidence.Subject.Revision != "" &&
		criterion.VerifierKind == completionGateActorPlugin && criterion.VerifierID == policy.VerifierID
}

func (r *Repository) guardStrictCompletionTx(ctx context.Context, tx *sql.Tx, taskID string, snapshot *models.TaskCompletionGateSnapshot) error {
	policy := r.strictCompletionPolicy.Load()
	criterion := strictRequiredCriterion(taskID, snapshot.Criteria)
	if policy == nil || policy.Check == nil || !r.strictCriterionTrusted(taskID, criterion) || len(snapshot.Blockers) != 0 {
		return repoerrors.ErrTaskCompletionGateBlocked
	}
	receipt, err := r.readStrictCompletionReceipt(taskID, criterion.Evidence.Summary)
	if err != nil {
		return err
	}
	if err := r.checkStrictTaskVersionTx(ctx, tx, taskID, receipt.TaskResourceVersion); err != nil {
		return err
	}
	if err := r.checkStrictSessionVersionsTx(ctx, tx, taskID, receipt); err != nil {
		return err
	}
	if err := r.checkStrictReviewOrderTx(ctx, tx, taskID, receipt); err != nil {
		return err
	}
	if err := r.checkStrictActivityTx(ctx, tx, taskID, receipt.AcceptedAt); err != nil {
		return err
	}
	if policy.Check(ctx, taskID, criterion.Evidence.Summary) != nil {
		return repoerrors.ErrTaskCompletionGateBlocked
	}
	return nil
}

type strictCompletionReceipt struct {
	Format                        string    `json:"format"`
	TaskID                        string    `json:"task_id"`
	TaskResourceVersion           string    `json:"task_resource_version"`
	AcceptedAt                    time.Time `json:"accepted_at"`
	ActorID                       string    `json:"actor_id"`
	ImplementationSessionID       string    `json:"implementation_session_id"`
	ReviewSessionID               string    `json:"review_session_id"`
	ImplementationResourceVersion string    `json:"implementation_resource_version"`
	ReviewResourceVersion         string    `json:"review_resource_version"`
}

func (r *Repository) readStrictCompletionReceipt(taskID, summary string) (strictCompletionReceipt, error) {
	var receipt strictCompletionReceipt
	if len(summary) > 512*1024 || json.Unmarshal([]byte(summary), &receipt) != nil ||
		receipt.Format != "fleet-acceptance/v1" || receipt.TaskID != taskID || receipt.ActorID == "" || receipt.AcceptedAt.IsZero() || receipt.AcceptedAt.After(r.nowUTC()) ||
		receipt.ImplementationSessionID == "" || receipt.ReviewSessionID == "" || receipt.ImplementationSessionID == receipt.ReviewSessionID {
		return receipt, repoerrors.ErrTaskCompletionGateBlocked
	}
	return receipt, nil
}

func (r *Repository) checkStrictTaskVersionTx(ctx context.Context, tx *sql.Tx, taskID, expected string) error {
	var updatedAt time.Time
	if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT updated_at FROM tasks WHERE id = ?`), taskID).Scan(&updatedAt); err != nil {
		return err
	}
	version, err := time.Parse(time.RFC3339Nano, expected)
	if err != nil || !version.Equal(updatedAt) {
		return repoerrors.ErrTaskCompletionGateBlocked
	}
	return nil
}

func (r *Repository) checkStrictSessionVersionsTx(ctx context.Context, tx *sql.Tx, taskID string, receipt strictCompletionReceipt) error {
	for id, expected := range map[string]string{receipt.ImplementationSessionID: receipt.ImplementationResourceVersion, receipt.ReviewSessionID: receipt.ReviewResourceVersion} {
		var observed time.Time
		if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT updated_at FROM task_sessions WHERE id = ? AND task_id = ?`), id, taskID).Scan(&observed); err != nil {
			return repoerrors.ErrTaskCompletionGateBlocked
		}
		version, err := time.Parse(time.RFC3339Nano, expected)
		if err != nil || !version.Equal(observed) {
			return repoerrors.ErrTaskCompletionGateBlocked
		}
	}
	return nil
}

func (r *Repository) checkStrictReviewOrderTx(ctx context.Context, tx *sql.Tx, taskID string, receipt strictCompletionReceipt) error {
	var implementationEnd, reviewStart time.Time
	if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT completed_at FROM task_session_turns WHERE task_id = ? AND task_session_id = ? AND completed_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1`), taskID, receipt.ImplementationSessionID).Scan(&implementationEnd); err != nil {
		return repoerrors.ErrTaskCompletionGateBlocked
	}
	if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT started_at FROM task_session_turns WHERE task_id = ? AND task_session_id = ? AND completed_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1`), taskID, receipt.ReviewSessionID).Scan(&reviewStart); err != nil || reviewStart.Before(implementationEnd) {
		return repoerrors.ErrTaskCompletionGateBlocked
	}
	return nil
}

func (r *Repository) checkStrictActivityTx(ctx context.Context, tx *sql.Tx, taskID string, acceptedAt time.Time) error {
	// 新一轮、尚未结束的一轮或仍在执行的会话，均要求重新验收。
	var changed int
	if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT COUNT(*) FROM task_session_turns WHERE task_id = ? AND (completed_at IS NULL OR updated_at > ? OR started_at > ?)`), taskID, acceptedAt, acceptedAt).Scan(&changed); err != nil {
		return err
	}
	if changed != 0 {
		return repoerrors.ErrTaskCompletionGateBlocked
	}
	if err := tx.QueryRowContext(ctx, r.db.Rebind(`SELECT COUNT(*) FROM task_sessions WHERE task_id = ? AND state NOT IN (?, ?, ?, ?, ?)`),
		taskID, models.TaskSessionStateWaitingForInput, models.TaskSessionStateIdle, models.TaskSessionStateCompleted, models.TaskSessionStateFailed, models.TaskSessionStateCancelled).Scan(&changed); err != nil {
		return err
	}
	if changed != 0 {
		return repoerrors.ErrTaskCompletionGateBlocked
	}
	return nil
}
