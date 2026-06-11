import { LANG } from "./language.js";
import { getClinicFacts } from "./clinicInfo.js";

function clinicPhone() {
	return getClinicFacts().phone;
}

function clinicAddress() {
	return getClinicFacts().address;
}

function clinicName() {
	return getClinicFacts().name;
}

const PHONE = () => clinicPhone();
const ADDRESS = () => clinicAddress();
const NAME = () => clinicName();

/** Full clinic block: name, address, timings, phone — required for greetings & clinic info. */
function buildClinicBlocks() {
	const name = NAME();
	const address = ADDRESS();
	const phone = PHONE();

	return {
		[LANG.EN]: {
			greetingIntro: `Welcome to ${name}.`,
			addressLabel: "📍 Address:",
			timingsLabel: "🕒 Timings:",
			timings: "Monday to Sunday, 10:00 AM – 8:00 PM",
			contactLabel: "📞 Contact:",
			closing:
				"For detailed treatment guidance and consultation, please visit the clinic. How may we assist you today?"
		},
		[LANG.HI]: {
			greetingIntro: `नमस्ते। ${name} में आपका स्वागत है।`,
			addressLabel: "📍 पता:",
			timingsLabel: "🕒 समय:",
			timings: "प्रतिदिन सुबह 10:00 बजे से रात 8:00 बजे तक",
			contactLabel: "📞 संपर्क:",
			closing:
				"उपचार संबंधी सही सलाह और विस्तृत जानकारी के लिए कृपया क्लिनिक पर आएं। हम आपकी कैसे सहायता कर सकते हैं?"
		},
		[LANG.MR]: {
			greetingIntro: `नमस्कार. ${name} मध्ये आपले स्वागत आहे.`,
			addressLabel: "📍 पत्ता:",
			timingsLabel: "🕒 वेळ:",
			timings: "दररोज सकाळी 10:00 ते रात्री 8:00",
			contactLabel: "📞 संपर्क:",
			closing:
				"उपचारांबाबत अधिक माहिती आणि योग्य सल्ल्यासाठी कृपया क्लिनिकला भेट द्या. आम्ही आपली कशी मदत करू शकतो?"
		}
	};
}

export function buildFullClinicInfoReply(lang, { introLine } = {}) {
	const l = lang === LANG.MR || lang === LANG.HI ? lang : LANG.EN;
	const blocks = buildClinicBlocks()[l];
	const intro = introLine || blocks.greetingIntro;

	return [
		intro,
		"",
		blocks.addressLabel,
		ADDRESS(),
		"",
		blocks.timingsLabel,
		blocks.timings,
		"",
		blocks.contactLabel,
		PHONE(),
		"",
		blocks.closing
	].join("\n");
}

export const I18N = {
	[LANG.EN]: {
		treatmentGeneric: `Thank you for contacting ${NAME()}.\n\nWe offer Hair, Skin, Dental, PRP, GFC, Hair Transplant, and Aesthetic treatments. The right option depends on an in-person consultation with our doctors.\n\n📍 Address:\n${ADDRESS()}\n\n🕒 Timings:\nMonday to Sunday, 10:00 AM – 8:00 PM\n\n📞 Contact:\n${PHONE()}\n\nFor more information, please visit the clinic or book an appointment.`,
		pricing: `Thank you for contacting ${NAME()}.\n\nTreatment costs vary based on your condition and the doctor's assessment. For accurate pricing, please visit the clinic for a consultation.\n\n📍 Address:\n${ADDRESS()}\n\n🕒 Timings:\nMonday to Sunday, 10:00 AM – 8:00 PM\n\n📞 Contact:\n${PHONE()}\n\nWould you like to schedule an appointment?`,
		ctaTreatment: "For more information, please visit the clinic or book an appointment.",
		ctaAppointment: "Would you like to book an appointment?",
		appointmentBookHint:
			"To book an appointment, send:\nBook appointment for <Name> on <date> at <time>\n\nExample:\nBook appointment for Pratik on 1 June at 1 PM"
	},
	[LANG.HI]: {
		treatmentGeneric: `डर्माप्लास्ट एस्थेटिक क्लिनिक से संपर्क करने के लिए धन्यवाद।\n\nहम हेयर, स्किन, डेंटल, PRP, GFC, हेयर ट्रांसप्लांट और एस्थेटिक उपचार प्रदान करते हैं। सही उपचार डॉक्टर की जांच के बाद तय होता है।\n\n📍 पता:\n${ADDRESS()}\n\n🕒 समय:\nप्रतिदिन सुबह 10:00 बजे से रात 8:00 बजे तक\n\n📞 संपर्क:\n${PHONE()}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		pricing: `डर्माप्लास्ट एस्थेटिक क्लिनिक से संपर्क करने के लिए धन्यवाद।\n\nउपचार की लागत व्यक्तिगत जरूरत और डॉक्टर के मूल्यांकन पर निर्भर करती है। सही कीमत के लिए कृपया क्लिनिक में परामर्श लें।\n\n📍 पता:\n${ADDRESS()}\n\n🕒 समय:\nप्रतिदिन सुबह 10:00 बजे से रात 8:00 बजे तक\n\n📞 संपर्क:\n${PHONE()}\n\nक्या आप अपॉइंटमेंट बुक करना चाहते हैं?`,
		ctaTreatment: "अधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।",
		ctaAppointment: "क्या आप अपॉइंटमेंट बुक करना चाहते हैं?",
		appointmentBookHint:
			"अपॉइंटमेंट बुक करने के लिए भेजें:\nBook appointment for <नाम> on <तारीख> at <समय>\n\nउदाहरण:\nBook appointment for Pratik on 1 June at 1 PM"
	},
	[LANG.MR]: {
		treatmentGeneric: `डर्माप्लास्ट एस्थेटिक क्लिनिकशी संपर्क केल्याबद्दल धन्यवाद.\n\nआम्ही केस, त्वचा, दात, PRP, GFC, हेअर ट्रान्सप्लांट आणि एस्थेटिक उपचार देतो. योग्य उपचार डॉक्टरांच्या तपासणीनंतर ठरतो.\n\n📍 पत्ता:\n${ADDRESS()}\n\n🕒 वेळ:\nदररोज सकाळी 10:00 ते रात्री 8:00\n\n📞 संपर्क:\n${PHONE()}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`,
		pricing: `डर्माप्लास्ट एस्थेटिक क्लिनिकशी संपर्क केल्याबद्दल धन्यवाद.\n\nउपचाराचा खर्च व्यक्तिगत गरजा आणि डॉक्टरांच्या मूल्यांकनावर अवलंबून असतो. अचूक किमतीसाठी कृपया क्लिनिकला भेट द्या.\n\n📍 पत्ता:\n${ADDRESS()}\n\n🕒 वेळ:\nदररोज सकाळी 10:00 ते रात्री 8:00\n\n📞 संपर्क:\n${PHONE()}\n\nअपॉइंटमेंट बुक करायची आहे का?`,
		ctaTreatment: "अधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.",
		ctaAppointment: "अपॉइंटमेंट बुक करायची आहे का?",
		appointmentBookHint:
			"अपॉइंटमेंटसाठी पाठवा:\nBook appointment for <नाव> on <तारीख> at <वेळ>\n\nउदाहरण:\nBook appointment for Pratik on 1 June at 1 PM"
	}
};

I18N[LANG.EN].general = buildFullClinicInfoReply(LANG.EN, {
	introLine: `Thank you for contacting ${NAME()}. Here is our clinic information:`
});
I18N[LANG.HI].general = buildFullClinicInfoReply(LANG.HI, {
	introLine: "धन्यवाद। यहाँ हमारी क्लिनिक की जानकारी है:"
});
I18N[LANG.MR].general = buildFullClinicInfoReply(LANG.MR, {
	introLine: "धन्यवाद. आमच्या क्लिनिकची माहिती:"
});

/** Clinic footer for treatment replies (address + timings + phone). */
export function clinicDetailsFooter(lang) {
	const l = lang === LANG.MR || lang === LANG.HI ? lang : LANG.EN;
	const blocks = buildClinicBlocks()[l];
	return [
		blocks.addressLabel,
		ADDRESS(),
		"",
		blocks.timingsLabel,
		blocks.timings,
		"",
		blocks.contactLabel,
		PHONE()
	].join("\n");
}

/** Short patient-friendly treatment explanations (3–6 lines + full clinic details). */
export const TREATMENT_EDUCATION_I18N = {
	hair_transplant: {
		[LANG.EN]: `Hair Transplant is a medical procedure used to restore hair in areas affected by hair loss. Healthy hair follicles are placed where hair is thin or absent, and results develop gradually over several months.\n\nFor detailed evaluation, please visit ${NAME()}.\n\n${clinicDetailsFooter(LANG.EN)}\n\nWould you like to book an appointment?`,
		[LANG.HI]: `हेयर ट्रांसप्लांट एक चिकित्सा प्रक्रिया है जिसमें बालों को घने बनाने या गंजे हिस्से को कवर करने के लिए बाल प्रत्यारोपित किए जाते हैं।\n\nअधिक जानकारी और सही सलाह के लिए कृपया ${NAME()} में विजिट करें।\n\n${clinicDetailsFooter(LANG.HI)}\n\nक्या आप अपॉइंटमेंट बुक करना चाहते हैं?`,
		[LANG.MR]: `हेअर ट्रान्सप्लांट ही केस गळती किंवा टक्कल पडलेल्या भागात नवीन केस लावण्याची एक वैद्यकीय प्रक्रिया आहे.\n\nअधिक माहिती आणि योग्य सल्ल्यासाठी कृपया ${NAME()} ला भेट द्या.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअपॉइंटमेंट बुक करायची आहे का?`
	},
	prp: {
		[LANG.EN]: `PRP (Platelet-Rich Plasma) Therapy uses growth factors from your own blood on the scalp or skin to support healing and hair growth.\n\nPlease visit ${NAME()} for a personalised consultation.\n\n${clinicDetailsFooter(LANG.EN)}\n\nWould you like to book an appointment?`,
		[LANG.HI]: `PRP थेरेपी में आपके खून से तैयार प्लेटलेट्स को स्कैल्प या त्वचा पर लगाया जाता है, जिससे बालों के विकास में मदद मिल सकती है।\n\nकृपया ${NAME()} में परामर्श लें।\n\n${clinicDetailsFooter(LANG.HI)}\n\nक्या आप अपॉइंटमेंट बुक करना चाहते हैं?`,
		[LANG.MR]: `PRP थेरपीमध्ये रुग्णाच्या रक्तातून वाढीचे घटक केस किंवा त्वचेवर वापरले जातात.\n\nकृपया ${NAME()} ला भेट द्या.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअपॉइंटमेंट बुक करायची आहे का?`
	},
	gfc: {
		[LANG.EN]: `GFC therapy uses concentrated growth factors from your blood to improve scalp health and support hair regrowth when recommended by a doctor.\n\n${clinicDetailsFooter(LANG.EN)}\n\nFor more information, please visit the clinic or book an appointment.`,
		[LANG.HI]: `GFC थेरेपी में रक्त से तैयार ग्रोथ फैक्टर्स का उपयोग स्कैल्प की सेहत सुधारने में मदद के लिए किया जाता है।\n\n${clinicDetailsFooter(LANG.HI)}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		[LANG.MR]: `GFC थेरपीमध्ये रक्तातून वाढीचे घटक डोक्याच्या त्वचेसाठी व केस वाढीसाठी उपयोग केले जातात.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`
	},
	hair_fall: {
		[LANG.EN]: `Hair fall treatment finds the cause of shedding and improves scalp health with medicines, PRP, GFC, or other options after a doctor's check-up.\n\n${clinicDetailsFooter(LANG.EN)}\n\nFor more information, please visit the clinic or book an appointment.`,
		[LANG.HI]: `हेयर फॉल उपचार में बाल झड़ने का कारण पता करके स्कैल्प और बालों की सेहत सुधारने पर ध्यान दिया जाता है।\n\n${clinicDetailsFooter(LANG.HI)}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		[LANG.MR]: `केस गळण्याच्या उपचारात गळतीचे कारण शोधून डोक्याची त्वचा आणि केसांचे आरोग्य सुधारण्यावर लक्ष दिले जाते.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`
	},
	beard_transplant: {
		[LANG.EN]: `Beard transplant improves beard density and shape after a consultation with our doctors.\n\n${clinicDetailsFooter(LANG.EN)}\n\nFor more information, please visit the clinic or book an appointment.`,
		[LANG.HI]: `बियर्ड ट्रांसप्लांट में बियर्ड एरिया में बाल प्रत्यारोपित कर घनता सुधारी जाती है।\n\n${clinicDetailsFooter(LANG.HI)}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		[LANG.MR]: `बियर्ड ट्रान्सप्लांटमध्ये दाढीच्या भागात केस वाढवून घनता सुधारली जाते.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`
	},
	skin: {
		[LANG.EN]: `Skin treatments address acne, pigmentation, ageing, and texture with doctor-guided plans for your skin type.\n\n${clinicDetailsFooter(LANG.EN)}\n\nFor more information, please visit the clinic or book an appointment.`,
		[LANG.HI]: `त्वचा उपचार में मुंहासे, पिग्मेंटेशन और बनावट जैसी समस्याओं के लिए डॉक्टर के मार्गदर्शन में योजना बनाई जाती है।\n\n${clinicDetailsFooter(LANG.HI)}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		[LANG.MR]: `त्वचा उपचारात मुरुम, डाग आणि बनावट यासारख्या समस्यांसाठी डॉक्टरांच्या सल्ल्यानुसार योजना केली जाते.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`
	},
	acne: {
		[LANG.EN]: `Acne treatment helps control breakouts and reduce marks with medicines and procedures chosen after skin examination.\n\n${clinicDetailsFooter(LANG.EN)}\n\nFor more information, please visit the clinic or book an appointment.`,
		[LANG.HI]: `एक्ने उपचार में मुंहासे नियंत्रित करने और निशान कम करने के लिए त्वचा के अनुसार उपचार चुना जाता है।\n\n${clinicDetailsFooter(LANG.HI)}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		[LANG.MR]: `मुरुम उपचारात फोड कमी करणे आणि डाग उणे करण्यासाठी त्वचेनुसार उपचार निवडला जातो.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`
	},
	dental: {
		[LANG.EN]: `Dental treatments cover pain, cavities, gums, and smile concerns with a personalised plan from our dental team.\n\n${clinicDetailsFooter(LANG.EN)}\n\nFor more information, please visit the clinic or book an appointment.`,
		[LANG.HI]: `दंत उपचार में दर्द, दांत, मसूड़ों और स्माइल से जुड़ी समस्याओं के लिए परामर्श दिया जाता है।\n\n${clinicDetailsFooter(LANG.HI)}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		[LANG.MR]: `दंत उपचारात दातदुखी, दात, हिरड्या आणि हास्याशी संबंधित समस्यांसाठी तपासणी मिळते.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`
	},
	cosmetic: {
		[LANG.EN]: `Cosmetic procedures focus on safe, doctor-led aesthetic improvements for face and body after consultation.\n\n${clinicDetailsFooter(LANG.EN)}\n\nFor more information, please visit the clinic or book an appointment.`,
		[LANG.HI]: `कॉस्मेटिक प्रक्रियाएं चेहरे और शरीर के लिए डॉक्टर के मार्गदर्शन में की जाती हैं।\n\n${clinicDetailsFooter(LANG.HI)}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		[LANG.MR]: `कॉस्मेटिक प्रक्रिया चेहरा आणि शरीरासाठी डॉक्टरांच्या देखरेखीत केल्या जातात.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`
	},
	generic: {
		[LANG.EN]: `We offer hair, skin, dental, and aesthetic treatments at ${NAME()}. The best option is decided after a doctor's consultation.\n\n${clinicDetailsFooter(LANG.EN)}\n\nFor more information, please visit the clinic or book an appointment.`,
		[LANG.HI]: `डर्माप्लास्ट एस्थेटिक क्लिनिक में कई हेयर, स्किन, डेंटल और एस्थेटिक उपचार उपलब्ध हैं।\n\n${clinicDetailsFooter(LANG.HI)}\n\nअधिक जानकारी के लिए कृपया क्लिनिक में विजिट करें या अपॉइंटमेंट बुक करें।`,
		[LANG.MR]: `डर्माप्लास्ट एस्थेटिक क्लिनिकमध्ये विविध केस, त्वचा, दात आणि एस्थेटिक उपचार उपलब्ध आहेत.\n\n${clinicDetailsFooter(LANG.MR)}\n\nअधिक माहितीसाठी कृपया क्लिनिकला भेट द्या किंवा अपॉइंटमेंट बुक करा.`
	}
};

export function msg(lang, key) {
	const l = I18N[lang] ? lang : LANG.EN;
	return I18N[l][key] || I18N[LANG.EN][key];
}

export function treatmentEducationTemplate(lang, treatmentKey) {
	const pack = TREATMENT_EDUCATION_I18N[treatmentKey] || TREATMENT_EDUCATION_I18N.generic;
	return pack[lang] || pack[LANG.EN];
}
