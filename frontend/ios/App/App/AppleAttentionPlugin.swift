import Foundation
import UIKit
import Capacitor
import ARKit
import Vision
import AVFoundation
import simd

@objc(AppleAttentionPlugin)
public class AppleAttentionPlugin: CAPPlugin, CAPBridgedPlugin, ARSessionDelegate, AVCaptureVideoDataOutputSampleBufferDelegate {
    public let identifier = "AppleAttentionPlugin"
    public let jsName = "AppleAttention"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise)
    ]

    private var arSession: ARSession?
    private var captureSession: AVCaptureSession?
    private let visionQueue = DispatchQueue(label: "app.studydiary.companion.attention.vision")
    private var watchdogTimer: DispatchSourceTimer?

    private var isRunningSession = false
    private var engineName = "none"
    private var lastEmitMono: TimeInterval = 0
    private var lastTrackedFaceMono: TimeInterval = 0
    private var cachedOrientation: UIInterfaceOrientation = .landscapeRight

    private func refreshInterfaceOrientation() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            for scene in UIApplication.shared.connectedScenes {
                if let ws = scene as? UIWindowScene {
                    self.cachedOrientation = ws.interfaceOrientation
                    break
                }
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve([
            "running": isRunningSession,
            "engine": engineName,
            "trueDepthSupported": ARFaceTrackingConfiguration.isSupported
        ])
    }

    @objc func startSession(_ call: CAPPluginCall) {
        if isRunningSession {
            call.resolve([
                "started": true,
                "engine": engineName
            ])
            return
        }

        let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
        if authStatus == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                if granted {
                    self?.bootAppropriateEngine(call)
                } else {
                    call.reject("未授权前置摄像头权限")
                }
            }
            return
        } else if authStatus == .denied || authStatus == .restricted {
            call.reject("前置摄像头权限已在系统设置中关闭")
            return
        }

        bootAppropriateEngine(call)
    }

    private func bootAppropriateEngine(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.stopInternal()
            self.refreshInterfaceOrientation()

            let now = ProcessInfo.processInfo.systemUptime
            self.lastEmitMono = 0
            self.lastTrackedFaceMono = now

            if ARFaceTrackingConfiguration.isSupported {
                let session = ARSession()
                session.delegate = self
                let cfg = ARFaceTrackingConfiguration()
                cfg.isLightEstimationEnabled = false
                if #available(iOS 13.0, *) {
                    cfg.maximumNumberOfTrackedFaces = 1
                }
                if let smallestFormat = ARFaceTrackingConfiguration.supportedVideoFormats.min(by: {
                    ($0.imageResolution.width * $0.imageResolution.height) < ($1.imageResolution.width * $1.imageResolution.height)
                }) {
                    cfg.videoFormat = smallestFormat
                }
                session.run(cfg, options: [.resetTracking, .removeExistingAnchors])
                self.arSession = session
                self.engineName = "arkit_truedepth"
                self.isRunningSession = true
                self.startEmptySeatWatchdog()
                call.resolve([
                    "started": true,
                    "engine": self.engineName
                ])
            } else {
                let ok = self.startVisionFallback()
                if ok {
                    self.engineName = "apple_vision"
                    self.isRunningSession = true
                    self.startEmptySeatWatchdog()
                    call.resolve([
                        "started": true,
                        "engine": self.engineName
                    ])
                } else {
                    call.reject("无法启动前置摄像头")
                }
            }
        }
    }

    @objc func stopSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.stopInternal()
            call.resolve(["stopped": true])
        }
    }

    private func stopInternal() {
        isRunningSession = false
        watchdogTimer?.cancel()
        watchdogTimer = nil
        arSession?.pause()
        arSession = nil
        if let cap = captureSession {
            visionQueue.async {
                cap.stopRunning()
            }
        }
        captureSession = nil
        engineName = "none"
    }

    private func startEmptySeatWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 0.35, repeating: 0.25)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.isRunningSession else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if now - self.lastTrackedFaceMono >= 0.45 && now - self.lastEmitMono >= 0.23 {
                self.lastEmitMono = now
                self.refreshInterfaceOrientation()
                self.notifyListeners("attentionFrame", data: [
                    "tsMs": Int(Date().timeIntervalSince1970 * 1000.0),
                    "present": false,
                    "engine": self.engineName
                ])
            }
        }
        timer.resume()
        watchdogTimer = timer
    }

    private func clamp1000(_ val: Float) -> Int {
        return max(-1000, min(1000, Int(round(val))))
    }

    private func projectPoint(_ p: simd_float3, center: simd_float3) -> (Int, Int) {
        let nx = (-center.x * 850.0) + (-(p.x - center.x) * 4800.0)
        let ny = (-center.y * 850.0) + (-(p.y - center.y) * 4800.0)
        return (clamp1000(nx), clamp1000(ny))
    }

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard isRunningSession else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard let faceAnchor = frame.anchors.compactMap({ $0 as? ARFaceAnchor }).first(where: { $0.isTracked }) else {
            return
        }

        lastTrackedFaceMono = now
        if now - lastEmitMono < 0.23 {
            return
        }
        lastEmitMono = now

        let viewMat = frame.camera.viewMatrix(for: cachedOrientation)
        let faceCam = simd_mul(viewMat, faceAnchor.transform)
        let center = simd_make_float3(faceCam.columns.3.x, faceCam.columns.3.y, faceCam.columns.3.z)
        let distCm = max(10, min(250, Int(round(simd_length(center) * 100.0))))

        let headFwd = simd_normalize(simd_make_float3(faceCam.columns.2.x, faceCam.columns.2.y, faceCam.columns.2.z))
        let headYawDeg = Double(atan2(-headFwd.x, max(0.001, headFwd.z)) * 180.0 / .pi)
        let headPitchDeg = Double(asin(max(-1.0, min(1.0, headFwd.y))) * 180.0 / .pi)

        let leftEyeCam = simd_mul(faceCam, faceAnchor.leftEyeTransform)
        let rightEyeCam = simd_mul(faceCam, faceAnchor.rightEyeTransform)
        let leftOrigin = simd_make_float3(leftEyeCam.columns.3.x, leftEyeCam.columns.3.y, leftEyeCam.columns.3.z)
        let rightOrigin = simd_make_float3(rightEyeCam.columns.3.x, rightEyeCam.columns.3.y, rightEyeCam.columns.3.z)
        let leftFwd = simd_normalize(simd_make_float3(leftEyeCam.columns.2.x, leftEyeCam.columns.2.y, leftEyeCam.columns.2.z))
        let rightFwd = simd_normalize(simd_make_float3(rightEyeCam.columns.2.x, rightEyeCam.columns.2.y, rightEyeCam.columns.2.z))
        let avgEyeFwd = simd_normalize((leftFwd + rightFwd) * 0.5)

        let gazeYawDeg = Double(atan2(-avgEyeFwd.x, max(0.001, avgEyeFwd.z)) * 180.0 / .pi)
        let gazePitchDeg = Double(asin(max(-1.0, min(1.0, avgEyeFwd.y))) * 180.0 / .pi)

        let blinkL = faceAnchor.blendShapes[.eyeBlinkLeft]?.floatValue ?? 0.0
        let blinkR = faceAnchor.blendShapes[.eyeBlinkRight]?.floatValue ?? 0.0
        let blinkPct = max(0, min(100, Int(round(((blinkL + blinkR) * 0.5) * 100.0))))

        let verts = faceAnchor.geometry.vertices
        let vCount = verts.count
        var flatPoints: [Int] = []
        flatPoints.reserveCapacity(168)

        for i in 0..<78 {
            let vIdx = vCount > 0 ? min(vCount - 1, (i * vCount) / 78) : 0
            let lv = vCount > 0 ? verts[vIdx] : simd_float3(0, 0, 0)
            let wp4 = simd_mul(faceCam, simd_float4(lv.x, lv.y, lv.z, 1.0))
            let (px, py) = projectPoint(simd_make_float3(wp4.x, wp4.y, wp4.z), center: center)
            flatPoints.append(px)
            flatPoints.append(py)
        }

        let specials: [simd_float3] = [
            leftOrigin,
            leftOrigin + leftFwd * 0.14,
            rightOrigin,
            rightOrigin + rightFwd * 0.14,
            center,
            center + headFwd * 0.12
        ]
        for sp in specials {
            let (sx, sy) = projectPoint(sp, center: center)
            flatPoints.append(sx)
            flatPoints.append(sy)
        }

        notifyListeners("attentionFrame", data: [
            "tsMs": Int(Date().timeIntervalSince1970 * 1000.0),
            "present": true,
            "engine": engineName,
            "distanceCm": distCm,
            "blinkPct": blinkPct,
            "headPitchDeg": round(headPitchDeg * 10.0) / 10.0,
            "headYawDeg": round(headYawDeg * 10.0) / 10.0,
            "gazePitchDeg": round(gazePitchDeg * 10.0) / 10.0,
            "gazeYawDeg": round(gazeYawDeg * 10.0) / 10.0,
            "points": flatPoints
        ])
    }

    private func startVisionFallback() -> Bool {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let input = try? AVCaptureDeviceInput(device: device) else {
            return false
        }
        let session = AVCaptureSession()
        session.beginConfiguration()
        if session.canSetSessionPreset(.vga640x480) {
            session.sessionPreset = .vga640x480
        }
        if session.canAddInput(input) {
            session.addInput(input)
        }
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: visionQueue)
        if session.canAddOutput(output) {
            session.addOutput(output)
        }
        session.commitConfiguration()
        captureSession = session
        visionQueue.async {
            session.startRunning()
        }
        return true
    }

    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard isRunningSession else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastEmitMono < 0.24 {
            return
        }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let req = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .upMirrored, options: [:])
        try? handler.perform([req])

        guard let face = req.results?.first, let landmarks = face.landmarks else {
            return
        }

        lastTrackedFaceMono = now
        lastEmitMono = now

        let box = face.boundingBox
        let estDistCm = max(18, min(150, Int(round(16.0 / max(0.08, Double(box.width))))))
        let yawDeg = (face.yaw?.doubleValue ?? 0.0) * 180.0 / .pi
        let pitchDeg = (face.pitch?.doubleValue ?? 0.0) * 180.0 / .pi

        var rawPts: [CGPoint] = []
        if let allPts = landmarks.allPoints?.normalizedPoints {
            rawPts.append(contentsOf: allPts)
        }
        var flatPoints: [Int] = []
        flatPoints.reserveCapacity(168)

        for i in 0..<78 {
            let p = rawPts.isEmpty ? CGPoint(x: 0.5, y: 0.5) : rawPts[min(rawPts.count - 1, (i * rawPts.count) / 78)]
            let px = clamp1000(Float((p.x - 0.5) * 1200.0))
            let py = clamp1000(Float((0.5 - p.y) * 1200.0))
            flatPoints.append(px)
            flatPoints.append(py)
        }

        let lp = landmarks.leftPupil?.normalizedPoints.first ?? CGPoint(x: 0.36, y: 0.58)
        let rp = landmarks.rightPupil?.normalizedPoints.first ?? CGPoint(x: 0.64, y: 0.58)
        let lpx = clamp1000(Float((lp.x - 0.5) * 1200.0))
        let lpy = clamp1000(Float((0.5 - lp.y) * 1200.0))
        let rpx = clamp1000(Float((rp.x - 0.5) * 1200.0))
        let rpy = clamp1000(Float((0.5 - rp.y) * 1200.0))
        let dx = Int(round(sin(yawDeg * .pi / 180.0) * 220.0))
        let dy = Int(round(-sin(pitchDeg * .pi / 180.0) * 220.0))

        let tail = [
            lpx, lpy, max(-1000, min(1000, lpx + dx)), max(-1000, min(1000, lpy + dy)),
            rpx, rpy, max(-1000, min(1000, rpx + dx)), max(-1000, min(1000, rpy + dy)),
            0, 0, dx, dy
        ]
        flatPoints.append(contentsOf: tail)

        notifyListeners("attentionFrame", data: [
            "tsMs": Int(Date().timeIntervalSince1970 * 1000.0),
            "present": true,
            "engine": engineName,
            "distanceCm": estDistCm,
            "blinkPct": 10,
            "headPitchDeg": round(pitchDeg * 10.0) / 10.0,
            "headYawDeg": round(yawDeg * 10.0) / 10.0,
            "gazePitchDeg": round(pitchDeg * 10.0) / 10.0,
            "gazeYawDeg": round(yawDeg * 10.0) / 10.0,
            "points": flatPoints
        ])
    }
}
