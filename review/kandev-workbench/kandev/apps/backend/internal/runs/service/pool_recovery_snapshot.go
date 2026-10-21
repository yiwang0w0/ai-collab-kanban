package service

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
)

func (s *Service) loadPoolRecoverySnapshotTx(ctx context.Context, tx *sqlx.Tx, source poolRecoveryTaskSource, taskID, runID string) (poolRecoveryRead, error) {
	var snapshot poolRecoveryRead
	header, err := source.LoadPoolRecoveryTaskHeaderTx(ctx, tx, taskID)
	if err != nil {
		return snapshot, err
	}
	if header.TaskID != taskID || header.WorkspaceID == "" {
		return snapshot, models.ErrPoolRecoveryNotFound
	}
	run, err := s.repo.GetRunByIDTx(ctx, tx, runID)
	if err != nil {
		return snapshot, err
	}
	release, err := recoveryRunRelease(run, taskID, header.WorkspaceID)
	if err != nil {
		return snapshot, err
	}
	return poolRecoveryRead{header: header, run: run, release: release}, nil
}

func (s *Service) validatePoolRecoveryVersionsTx(ctx context.Context, tx *sqlx.Tx, snapshot poolRecoveryRead, command models.PoolRecoveryCommand) error {
	expected, err := time.Parse(time.RFC3339Nano, command.ExpectedTaskVersion)
	actual, actualErr := time.Parse(time.RFC3339Nano, snapshot.header.Version)
	if err != nil || actualErr != nil || !expected.Equal(actual) {
		return models.ErrPoolRecoveryConflict
	}
	version, err := s.repo.PoolRecoveryRunVersionTx(ctx, tx, snapshot.run)
	if err != nil {
		return err
	}
	if version == "" || version != command.ExpectedRunVersion {
		return models.ErrPoolRecoveryConflict
	}
	return nil
}

func (s *Service) notifyPoolRecovery(taskID string, event *models.RunEvent, committed bool) {
	if committed && event != nil && s.poolProjectionObserver != nil {
		s.poolProjectionObserver(models.PoolProjectionCommit{TaskID: taskID, RunID: event.RunID, Sequence: event.Seq, Kind: models.PoolProjectionRecovery})
	}
}
