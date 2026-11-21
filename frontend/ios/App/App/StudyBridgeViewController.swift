import UIKit
import Capacitor

@objc(StudyBridgeViewController)
class StudyBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppleAttentionPlugin())
    }
}
