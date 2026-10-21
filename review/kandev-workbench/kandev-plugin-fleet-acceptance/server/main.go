// 插件由宿主作为受管子进程启动；传输和生命周期沿用官方 SDK。
package main

import "github.com/kandev/kandev/pkg/pluginsdk"

func main() {
	pluginsdk.Serve(&fleetPlugin{})
}
