package backendapp

import "context"

// CheckExecutionQuiescent 转发真实运行时占用，不把适配器缺能力当作已释放。
func (a *lifecycleAdapter) CheckExecutionQuiescent(ctx context.Context, executionID, taskID, sessionID string) error {
	return a.mgr.CheckExecutionQuiescent(ctx, executionID, taskID, sessionID)
}
