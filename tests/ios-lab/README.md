# Owned simulator sound gesture

This small Apple UI-test project taps only the `Start test with sound` button
inserted by the local initial-delay acceptance harness. Use a disposable test
simulator and the generated local page; it does not inspect personal Safari tabs.
Xcode and its simulator runtime must already be installed and licensed.

1. Run `tests/initial-delay-platform-browser.test.mjs` with `INITIAL_DEVICE=ios`.
2. Trust its freshly emitted test certificate in the selected simulator with
   `xcrun simctl keychain <test-udid> add-root-cert <emitted-certificate>`.
3. Open the emitted viewer URL on that simulator, with a unique `run` query.
4. Build once and run this scheme against that exact simulator:

```
xcodebuild -project tests/ios-lab/SameEndLab.xcodeproj -scheme SameEndLab \
  -destination 'platform=iOS Simulator,id=<test-udid>' \
  -derivedDataPath /absolute/private/evidence/DerivedData \
  -parallel-testing-enabled NO test CODE_SIGNING_ALLOWED=NO
```

Later runs can use `test-without-building`. The test activates simulator Safari,
waits for the uniquely named owned test button and taps it once. Missing buttons
fail the test. It does not weaken autoplay rules or grant a permission. Simulator
sound output needs a separately scoped measurement; a successful tap is not
speaker or playback acceptance. Keep build products and result bundles outside Git.
