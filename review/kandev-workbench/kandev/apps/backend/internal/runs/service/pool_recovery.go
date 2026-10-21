package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/runs/models"
	workflowmodels "github.com/kandev/kandev/internal/workflow/models"
)

type poolRecoveryTaskSource interface {
	LoadPoolRecoveryTaskHeaderTx(context.Context, *sqlx.Tx, string) (models.PoolRecoveryTaskHeader, error)
}

// RecoverPoolRun 只接受原生任务服务核对权限后的明确操作。
func (s *Service) RecoverPoolRun(ctx context.Context, taskID string, command models.PoolRecoveryCommand) (*models.RunEvent, error) {
	actor, human := poolRecoveryHuman(ctx)
	if !human || !command.Confirm {
		return nil, models.ErrPoolRecoveryConfirmation
	}
	if taskID == "" || len(taskID) > 256 || !command.Valid() {
		return nil, models.ErrPoolRecoveryInvalid
	}
	source, supported := s.poolReleaseSource.(poolRecoveryTaskSource)
	if !supported || s.poolEnqueueAdmission == nil || dialect.IsPostgres(s.repo.Writer().DriverName()) {
		return nil, models.ErrPoolAdmissionUnavailable
	}
	if command.Action == "stop" {
		return s.recoverPoolStop(ctx, source, taskID, actor, command)
	}
	if command.Action == "retry" {
		return s.recoverPoolRetry(ctx, source, taskID, actor, command)
	}
	if command.Action != "withdraw" {
		return nil, models.ErrPoolAdmissionUnavailable
	}
	var event *models.RunEvent
	var committed bool
	err := s.poolEnqueueAdmission.WithPoolEnqueueAdmission(ctx, taskID, func(admitted context.Context, preparing bool) error {
		var err error
		event, committed, err = s.withdrawPoolRun(admitted, source, taskID, actor, command, preparing)
		return err
	})
	if err != nil {
		return nil, err
	}
	s.notifyPoolRecovery(taskID, event, committed)
	return event, nil
}

func poolRecoveryHuman(ctx context.Context) (string, bool) {
	i, present := authn.IdentityFromContext(ctx)
	return i.UserID, present && !i.Synthetic && i.TokenID == "" && i.SessionID != "" &&
		i.UserID != "" && len(i.UserID) <= 256 && strings.TrimSpace(i.UserID) == i.UserID
}

func (s *Service) withdrawPoolRun(ctx context.Context, source poolRecoveryTaskSource, taskID, actor string, command models.PoolRecoveryCommand, preparing bool) (*models.RunEvent, bool, error) {
	tx, err := s.repo.BeginEnqueueTx(ctx, "")
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.repo.LockPoolTaskTx(ctx, tx, taskID); err != nil {
		return nil, false, err
	}
	snapshot, err := s.loadPoolRecoverySnapshotTx(ctx, tx, source, taskID, command.RunID)
	if err != nil {
		return nil, false, err
	}
	header, run, release := snapshot.header, snapshot.run, snapshot.release
	operation := models.PoolRecoveryOperation{Command: command, TaskID: taskID, WorkspaceID: header.WorkspaceID,
		ActorID: actor, EntryID: release.EntryID, Result: "withdrawn"}
	previous, err := s.repo.FindPoolRecoveryOperationTx(ctx, tx, command.RunID, command.OperationID)
	if err != nil {
		return nil, false, err
	}
	if previous != nil {
		var stored models.PoolRecoveryOperation
		if json.Unmarshal([]byte(previous.Payload), &stored) != nil || stored != operation {
			return nil, false, models.ErrPoolRecoveryConflict
		}
		return previous, false, nil
	}
	if err := checkPoolRecoveryManager(header, actor, command.ExpectedManagementVersion); err != nil {
		return nil, false, err
	}
	if preparing {
		return nil, false, models.ErrPoolTaskStartPreparing
	}
	if err := s.validatePoolWithdrawalTx(ctx, tx, header, run, release, command); err != nil {
		return nil, false, err
	}
	event, err := s.repo.WithdrawPoolRunTx(ctx, tx, run, operation)
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return event, true, nil
}

func checkPoolRecoveryManager(header models.PoolRecoveryTaskHeader, actor, version string) error {
	if header.ManagementVersion != version {
		return models.ErrPoolRecoveryConflict
	}
	switch header.ManagementOwnerKind {
	case "":
		return nil
	case "human":
		if header.ManagementOwnerActorID == actor {
			return nil
		}
	}
	return models.ErrPoolRecoveryConflict
}

func (s *Service) validatePoolWithdrawalTx(ctx context.Context, tx *sqlx.Tx, header models.PoolRecoveryTaskHeader, run *models.Run, release models.PoolReleaseSnapshot, command models.PoolRecoveryCommand) error {
	if header.Archived || header.Ephemeral {
		return models.ErrPoolRecoveryConflict
	}
	if err := s.validatePoolRecoveryVersionsTx(ctx, tx, poolRecoveryRead{header, run, release}, command); err != nil {
		return err
	}
	current, err := s.poolReleaseSource.LoadPoolReleaseTx(ctx, tx, header.TaskID, release.EntryID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, workflowmodels.ErrInvalidPoolStep) {
			return models.ErrPoolRecoveryConflict
		}
		return err
	}
	if !current.MatchesRun(run) || current.ActorID != release.ActorID || !current.ReleasedAt.Equal(release.ReleasedAt) {
		return models.ErrPoolRecoveryConflict
	}
	return nil
}

func recoveryRunRelease(run *models.Run, taskID, workspaceID string) (models.PoolReleaseSnapshot, error) {
	var envelope struct {
		Release models.PoolReleaseSnapshot `json:"pool_release"`
	}
	if run == nil || json.Unmarshal([]byte(run.Payload), &envelope) != nil {
		return models.PoolReleaseSnapshot{}, models.ErrPoolRecoveryNotFound
	}
	r := envelope.Release
	if taskID == "" || workspaceID == "" || r.TaskID != taskID || r.WorkspaceID != workspaceID || !r.MatchesRun(run) {
		return models.PoolReleaseSnapshot{}, models.ErrPoolRecoveryNotFound
	}
	return r, nil
}
