import XCTest
final class StartupTapTests: XCTestCase {
 func testStart() throws {
  continueAfterFailure=false
  let safari=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari")
  safari.activate()
  let button=safari.buttons["Start test with sound"].firstMatch
  XCTAssertTrue(button.waitForExistence(timeout:20),"Only the owned Same End test page may be tapped")
  button.tap()
  print("SAME_END_GESTURE_DELIVERED")
 }
}
