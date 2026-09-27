# DailyDoListWorkspaceCore

Foundation/Observation workspace behavior shared by the Mac and iPhone shells. `TabsStore` owns
open tabs, navigation and recently closed history; `NotePaths` owns naming and rename rules.
The original Mac navigation tests moved here unchanged. Platform editors retain their own
selection/scroll/undo; durable offline state lives in MobileKit behind shared protocol models.
