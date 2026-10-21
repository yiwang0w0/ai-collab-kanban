package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
)

// PoolReleaseSource 在队列写事务内读取原生任务批准，调用者不能提交自报快照。
type PoolReleaseSource interface {
	LoadPoolReleaseTx(context.Context, *sqlx.Tx, string, int64) (models.PoolReleaseSnapshot, error)
	CheckPoolReleaseReadyTx(context.Context, *sqlx.Tx, models.PoolReleaseSnapshot) error
}

// PoolEnqueueAdmission 由同一宿主协调器提供任务锁与启动准备占用。
type PoolEnqueueAdmission interface {
	WithPoolEnqueueAdmission(context.Context, string, func(context.Context, bool) error) error
}

var (
	ErrPoolPublisherUnavailable = errors.New("pool_publisher_unavailable")
	ErrPoolDispatchConflict     = errors.New("pool_dispatch_binding_conflict")
)

// SetPoolReleaseSource 只在构造期注入原生任务仓储，不接受工作流动作或请求字段。
func (s *Service) SetPoolReleaseSource(source PoolReleaseSource) { s.poolReleaseSource = source }

// SetPoolEnqueueAdmission 仅在构造时连接同一宿主的任务准入协调器。
func (s *Service) SetPoolEnqueueAdmission(admission PoolEnqueueAdmission) {
	s.poolEnqueueAdmission = admission
}

// QueuePoolRunAndReturn 保留原生入队、因果准入和信号；重复发布返回真实已有行。
func (s *Service) QueuePoolRunAndReturn(ctx context.Context, taskID string, entryID int64) (QueueOutcome, *models.Run, error) {
	if s.poolReleaseSource == nil || dialect.IsPostgres(s.repo.Writer().DriverName()) {
		return QueueOutcomeNone, nil, ErrPoolPublisherUnavailable
	}
	if s.poolEnqueueAdmission == nil {
		return QueueOutcomeNone, nil, models.ErrPoolAdmissionUnavailable
	}
	var outcome QueueOutcome
	var row *models.Run
	err := s.poolEnqueueAdmission.WithPoolEnqueueAdmission(ctx, taskID, func(admitted context.Context, preparing bool) error {
		var err error
		outcome, row, err = s.enqueuePoolRelease(admitted, taskID, entryID, preparing)
		return err
	})
	if err != nil {
		return QueueOutcomeNone, nil, err
	}
	if outcome == QueueOutcomeQueued {
		s.publishRunQueued(ctx, row, *row.IdempotencyKey)
		if s.poolProjectionObserver != nil {
			s.poolProjectionObserver(models.PoolProjectionCommit{TaskID: taskID, RunID: row.ID, Kind: "queued"})
		}
		s.signal()
	}
	return outcome, row, nil
}

func (s *Service) enqueuePoolRelease(ctx context.Context, taskID string, entryID int64, preparing bool) (QueueOutcome, *models.Run, error) {
	tx, err := s.repo.BeginEnqueueTx(ctx, "")
	if err != nil {
		return QueueOutcomeNone, nil, err
	}
	rec := &gateOutcomeRecorder{}
	defer s.flushGateOutcomes(ctx, rec)
	defer func() { _ = tx.Rollback() }()
	if err := s.repo.LockPoolTaskTx(ctx, tx, taskID); err != nil {
		return QueueOutcomeNone, nil, err
	}
	release, err := s.poolReleaseSource.LoadPoolReleaseTx(ctx, tx, taskID, entryID)
	if err != nil {
		return QueueOutcomeNone, nil, err
	}
	req, payload, err := poolQueueRequest(release)
	if err != nil {
		return QueueOutcomeNone, nil, err
	}
	existing, err := s.repo.FindPoolRunByKeyTx(ctx, tx, req.IdempotencyKey)
	if err != nil {
		return QueueOutcomeNone, nil, err
	}
	if existing != nil {
		if !matchesPoolDispatch(existing, release, payload) {
			return QueueOutcomeNone, nil, ErrPoolDispatchConflict
		}
		return QueueOutcomeDeduped, existing, nil
	}
	if err := s.repo.CheckPoolHistoryTx(ctx, tx, req.IdempotencyKey, release.ReleasedAt); err != nil {
		return QueueOutcomeNone, nil, err
	}
	if preparing {
		return QueueOutcomeNone, nil, models.ErrPoolTaskStartPreparing
	}
	if activeID, err := s.repo.FindActivePoolRunForTaskTx(ctx, tx, taskID); err != nil {
		return QueueOutcomeNone, nil, err
	} else if activeID != "" {
		return QueueOutcomeNone, nil, &models.PoolTaskBusyError{RunID: activeID}
	}
	if err := s.poolReleaseSource.CheckPoolReleaseReadyTx(ctx, tx, release); err != nil {
		return QueueOutcomeNone, nil, err
	}
	row, err := s.insertRun(ctx, tx, rec, release.AgentProfileID, req, payload)
	if err != nil {
		return QueueOutcomeNone, nil, err
	}
	if row.WorkspaceID != release.WorkspaceID {
		return QueueOutcomeNone, nil, ErrPoolDispatchConflict
	}
	if err := tx.Commit(); err != nil {
		return QueueOutcomeNone, nil, err
	}
	return QueueOutcomeQueued, row, nil
}

func matchesPoolDispatch(row *models.Run, release models.PoolReleaseSnapshot, payload string) bool {
	return release.MatchesRun(row) && row.Payload == payload
}

func poolQueueRequest(release models.PoolReleaseSnapshot) (QueueRunRequest, string, error) {
	key, err := release.DispatchKey()
	if err != nil {
		return QueueRunRequest{}, "", err
	}
	req := QueueRunRequest{TaskID: release.TaskID, WorkflowStepID: release.WorkflowStepID, AgentProfileID: release.AgentProfileID,
		Reason: models.PoolDispatchReason, IdempotencyKey: key,
		ActorKind: models.ActorKindUser, ActorID: release.ActorID, SkipCoalesce: true,
		Payload: map[string]any{"pool_release": release}}
	payload, err := encodePayload(runPayload(req, release.AgentProfileID))
	if err != nil {
		return QueueRunRequest{}, "", fmt.Errorf("序列化池派发: %w", err)
	}
	return req, payload, nil
}
