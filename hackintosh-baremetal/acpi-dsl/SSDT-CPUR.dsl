DefinitionBlock ("", "SSDT", 2, "ACDT", "CPUR", 0x00001000)
{
    External (\_SB_.PLTF, DeviceObj)
    External (\_SB_.PLTF.C000, DeviceObj)
    External (\_SB_.PCI0.SBRG, DeviceObj)
    External (\_SB_.PCI0.GPP1.PTXH, DeviceObj)
    External (\_SB_.PCI0.GP13.XHC0, DeviceObj)

    Scope (\_SB)
    {
        Method (_INI, 0, NotSerialized)
        {
        }
    }
}
