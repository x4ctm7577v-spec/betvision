#!/bin/bash
# Prepara el proyecto de Xcode en la nube (Codemagic). No hace falta tener Mac.
set -e
BUNDLE_ID="${BUNDLE_ID:-com.betvision.cienxbajo}"
VERSION="${APP_VERSION:-1.0.0}"

# 1) Crear la carpeta ios la primera vez
if [ ! -d ios ]; then npx cap add ios; fi
npm run assets || echo "Aviso: no se generaron íconos automáticos"
npx cap sync ios

PLIST=ios/App/App/Info.plist
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" 2>/dev/null || true; }
# 2) Nombre, cifrado estándar (evita la pregunta de exportación) y solo vertical en iPhone
pb "Set :CFBundleDisplayName BetVision" || true
pb "Add :CFBundleDisplayName string BetVision"
pb "Delete :ITSAppUsesNonExemptEncryption"; pb "Add :ITSAppUsesNonExemptEncryption bool false"
pb "Delete :UISupportedInterfaceOrientations"
pb "Add :UISupportedInterfaceOrientations array"
pb "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait"
pb "Delete :UIBackgroundModes"; pb "Add :UIBackgroundModes array"; pb "Add :UIBackgroundModes:0 string remote-notification"
pb "Delete :UIUserInterfaceStyle"; pb "Add :UIUserInterfaceStyle string Dark"

# 3) Permiso de avisos push (entitlement)
cat > ios/App/App/App.entitlements <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>aps-environment</key><string>production</string></dict></plist>
XML

# 4) Ajustes del proyecto: bundle id, versión, entitlements, solo iPhone
ruby -e '
require "xcodeproj"
p = Xcodeproj::Project.open("ios/App/App.xcodeproj")
t = p.targets.find { |x| x.name == "App" }
t.build_configurations.each do |c|
  s = c.build_settings
  s["PRODUCT_BUNDLE_IDENTIFIER"] = ENV["BUNDLE_ID"] || "com.betvision.cienxbajo"
  s["MARKETING_VERSION"] = ENV["APP_VERSION"] || "1.0.0"
  s["CURRENT_PROJECT_VERSION"] = ENV["BUILD_NUMBER"] || "1"
  s["CODE_SIGN_ENTITLEMENTS"] = "App/App.entitlements"
  s["TARGETED_DEVICE_FAMILY"] = "1"
end
p.save'

# 5) Conectar los avisos push en AppDelegate (lo pide el plugin de Capacitor)
python3 - <<'PY'
p = "ios/App/App/AppDelegate.swift"
s = open(p).read()
if "capacitorDidRegisterForRemoteNotifications" not in s:
    add = '''
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
'''
    i = s.rstrip().rfind("}")
    s = s[:i] + add + "}\n"
    open(p, "w").write(s)
PY
echo "Proyecto iOS listo: $BUNDLE_ID v$VERSION (build ${BUILD_NUMBER:-1})"
