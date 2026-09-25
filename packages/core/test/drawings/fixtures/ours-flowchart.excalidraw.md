---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
Browser ^tBrowser

API ^tApiNode

Database ^tDbStore

HTTPS ^tHttpsLb

Request path ^tCaption

%%
## Drawing
```json
{
	"type": "excalidraw",
	"version": 2,
	"source": "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.27.3",
	"elements": [
		{
			"id": "client",
			"type": "rectangle",
			"x": 0,
			"y": 0,
			"width": 180,
			"height": 80,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": null,
			"index": "a0",
			"roundness": {
				"type": 3
			},
			"seed": 261266463,
			"version": 1,
			"versionNonce": 601274372,
			"isDeleted": false,
			"boundElements": [
				{
					"id": "tBrowser",
					"type": "text"
				},
				{
					"id": "toApi",
					"type": "arrow"
				}
			],
			"updated": 1790000000000,
			"link": null,
			"locked": false
		},
		{
			"id": "tBrowser",
			"type": "text",
			"x": 51.5,
			"y": 27.5,
			"width": 77,
			"height": 25,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": null,
			"index": "a1",
			"roundness": null,
			"seed": 2037650186,
			"version": 1,
			"versionNonce": 314277733,
			"isDeleted": false,
			"boundElements": null,
			"updated": 1790000000000,
			"link": null,
			"locked": false,
			"text": "Browser",
			"fontSize": 20,
			"fontFamily": 5,
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "client",
			"originalText": "Browser",
			"autoResize": true,
			"lineHeight": 1.25
		},
		{
			"id": "api",
			"type": "rectangle",
			"x": 320,
			"y": 0,
			"width": 180,
			"height": 80,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": "backend",
			"index": "a2",
			"roundness": {
				"type": 3
			},
			"seed": 946514567,
			"version": 1,
			"versionNonce": 946607694,
			"isDeleted": false,
			"boundElements": [
				{
					"id": "tApiNode",
					"type": "text"
				},
				{
					"id": "toApi",
					"type": "arrow"
				},
				{
					"id": "toDb",
					"type": "arrow"
				}
			],
			"updated": 1790000000000,
			"link": null,
			"locked": false
		},
		{
			"id": "tApiNode",
			"type": "text",
			"x": 393.5,
			"y": 27.5,
			"width": 33,
			"height": 25,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": "backend",
			"index": "a3",
			"roundness": null,
			"seed": 718640249,
			"version": 1,
			"versionNonce": 1968560181,
			"isDeleted": false,
			"boundElements": null,
			"updated": 1790000000000,
			"link": null,
			"locked": false,
			"text": "API",
			"fontSize": 20,
			"fontFamily": 5,
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "api",
			"originalText": "API",
			"autoResize": true,
			"lineHeight": 1.25
		},
		{
			"id": "db",
			"type": "ellipse",
			"x": 320,
			"y": 200,
			"width": 180,
			"height": 90,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": "backend",
			"index": "a4",
			"roundness": null,
			"seed": 1461503683,
			"version": 1,
			"versionNonce": 757149611,
			"isDeleted": false,
			"boundElements": [
				{
					"id": "tDbStore",
					"type": "text"
				},
				{
					"id": "toDb",
					"type": "arrow"
				}
			],
			"updated": 1790000000000,
			"link": null,
			"locked": false
		},
		{
			"id": "tDbStore",
			"type": "text",
			"x": 366,
			"y": 232.5,
			"width": 88,
			"height": 25,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": "backend",
			"index": "a5",
			"roundness": null,
			"seed": 368050766,
			"version": 1,
			"versionNonce": 423555475,
			"isDeleted": false,
			"boundElements": null,
			"updated": 1790000000000,
			"link": null,
			"locked": false,
			"text": "Database",
			"fontSize": 20,
			"fontFamily": 5,
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "db",
			"originalText": "Database",
			"autoResize": true,
			"lineHeight": 1.25
		},
		{
			"id": "toApi",
			"type": "arrow",
			"x": 180,
			"y": 40,
			"width": 140,
			"height": 0,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": null,
			"index": "a6",
			"roundness": {
				"type": 2
			},
			"seed": 311676828,
			"version": 1,
			"versionNonce": 703352142,
			"isDeleted": false,
			"boundElements": [
				{
					"id": "tHttpsLb",
					"type": "text"
				}
			],
			"updated": 1790000000000,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					140,
					0
				]
			],
			"lastCommittedPoint": null,
			"startBinding": {
				"elementId": "client",
				"focus": 0,
				"gap": 5
			},
			"endBinding": {
				"elementId": "api",
				"focus": 0,
				"gap": 5
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"elbowed": false
		},
		{
			"id": "tHttpsLb",
			"type": "text",
			"x": 222.5,
			"y": 27.5,
			"width": 55,
			"height": 25,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": null,
			"index": "a7",
			"roundness": null,
			"seed": 1582703955,
			"version": 1,
			"versionNonce": 776395448,
			"isDeleted": false,
			"boundElements": null,
			"updated": 1790000000000,
			"link": null,
			"locked": false,
			"text": "HTTPS",
			"fontSize": 20,
			"fontFamily": 5,
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "toApi",
			"originalText": "HTTPS",
			"autoResize": true,
			"lineHeight": 1.25
		},
		{
			"id": "toDb",
			"type": "arrow",
			"x": 410,
			"y": 80,
			"width": 0,
			"height": 120,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": "backend",
			"index": "a8",
			"roundness": {
				"type": 2
			},
			"seed": 631809254,
			"version": 1,
			"versionNonce": 1781035852,
			"isDeleted": false,
			"boundElements": null,
			"updated": 1790000000000,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					0,
					120
				]
			],
			"lastCommittedPoint": null,
			"startBinding": {
				"elementId": "api",
				"focus": 0,
				"gap": 5
			},
			"endBinding": {
				"elementId": "db",
				"focus": 0,
				"gap": 5
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"elbowed": false
		},
		{
			"id": "tCaption",
			"type": "text",
			"x": 0,
			"y": 320,
			"width": 132,
			"height": 25,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": null,
			"index": "a9",
			"roundness": null,
			"seed": 1095705492,
			"version": 1,
			"versionNonce": 1906460826,
			"isDeleted": false,
			"boundElements": null,
			"updated": 1790000000000,
			"link": null,
			"locked": false,
			"text": "Request path",
			"fontSize": 20,
			"fontFamily": 5,
			"textAlign": "left",
			"verticalAlign": "top",
			"containerId": null,
			"originalText": "Request path",
			"autoResize": true,
			"lineHeight": 1.25
		},
		{
			"id": "backend",
			"type": "frame",
			"x": 300,
			"y": -20,
			"width": 220,
			"height": 330,
			"angle": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"groupIds": [],
			"frameId": null,
			"index": "aa",
			"roundness": null,
			"seed": 602788944,
			"version": 1,
			"versionNonce": 2078728406,
			"isDeleted": false,
			"boundElements": null,
			"updated": 1790000000000,
			"link": null,
			"locked": false,
			"name": "Backend"
		}
	],
	"appState": {
		"gridSize": null,
		"viewBackgroundColor": "#ffffff"
	},
	"files": {}
}
```
%%
