package backendapp

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPoolMockCompositionStaysClosedOutsideExistingMockOnlyE2E(t *testing.T) {
	for _, test := range []struct {
		name, e2e, mock string
	}{
		{"默认关闭", "", ""},
		{"仅端到端标记", "true", ""},
		{"仅模拟代理标记", "", "only"},
		{"端到端关闭", "false", "only"},
		{"混合真实提供商", "true", "hybrid"},
		{"非精确端到端标记", "TRUE", "only"},
		{"非精确模拟标记", "true", "ONLY"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("KANDEV_E2E_MOCK", test.e2e)
			t.Setenv("KANDEV_MOCK_AGENT", test.mock)
			require.NotPanics(t, func() { wireMockPoolRuntime(nil, nil, nil, nil, nil) },
				"关闭分支必须在触碰任何原生运行服务前返回")
		})
	}
}
